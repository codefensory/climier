#!/usr/bin/env node
/**
 * Genera un `ClimierSnapshot` **real** a partir del state file del CLI.
 *
 * Para qué sirve: el board se diseñó contra el fixture de `data/snapshot.ts` (17 tasks,
 * 18 gates), pero el proyecto real tiene 594 nodos, 517 tasks, 65 gates y 906 edges. Este
 * script traduce ese estado al shape que la UI ya sabe leer (`data/climier/contract.ts`), así
 * se puede abrir `http://localhost:5173/?data=real` y trabajar contra el DAG de verdad.
 *
 * Por qué existe y no basta el state file: el state file tiene `nodes`, `edges`,
 * `initiatives` y un `log` append-only, pero **no** tiene `last_activity` ni
 * `recent_activity`, que son los dos campos derivados que la proyección sí lee
 * (`projection.ts`: `updatedAt` y la actividad del detalle). El resto (`derived`, `summary`)
 * la UI lo recalcula desde `nodes` + `edges`, pero se escribe igual para que el archivo sea
 * un snapshot completo y no un fragmento.
 *
 * Uso:
 *   node scripts/build-real-snapshot.mjs                        # proyecto más reciente
 *   node scripts/build-real-snapshot.mjs --project <project-id> # uno concreto
 *   node scripts/build-real-snapshot.mjs --log-tail 3           # archivo más chico
 *   node scripts/build-real-snapshot.mjs --out /tmp/x.json      # otro destino
 *
 * Determinista a propósito: el orden es estable y `generated_at` sale del mtime del state
 * file, no del reloj, así correrlo dos veces no ensucia el working tree.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROJECTS_DIR = join(homedir(), ".climier", "projects");
const DEFAULT_OUT = "src/modules/tasks/data/climier/realSnapshot.json";

// ─── Estados: espejo de las constantes de `projection.ts` ────────────────────────────────────
// Si cambian allá, cambian acá. La UI recalcula el estado derivado por su cuenta, así que una
// discrepancia no puede alterar lo que se ve; estos pools son para que el snapshot esté completo.

const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);
const NON_READY_TASK_STATUSES = new Set(["in_progress", "submitted", "done", "archived", "canceled"]);

// ─── Argumentos ──────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { project: null, state: null, out: DEFAULT_OUT, logTail: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=");
    const value = inline ?? argv[i + 1];
    if (flag === "--project") out.project = value;
    else if (flag === "--state") out.state = value;
    else if (flag === "--out") out.out = value;
    else if (flag === "--log-tail") out.logTail = Number(value);
    if (inline === undefined && value !== undefined) i += 1;
  }
  return out;
}

/** El state file del proyecto más reciente, o el de `--project <id>`. */
function resolveStateFile(args) {
  if (args.state) return { file: resolve(args.state), projectId: dirname(resolve(args.state)).split("/").pop() };
  const ids = existsSync(PROJECTS_DIR)
    ? readdirSync(PROJECTS_DIR).filter((id) => existsSync(join(PROJECTS_DIR, id, "tasks.json")))
    : [];
  if (ids.length === 0) throw new Error(`no hay proyectos en ${PROJECTS_DIR}`);
  const chosen = args.project
    ? ids.find((id) => id === args.project || id.startsWith(args.project))
    : ids.map((id) => ({ id, mtime: statSync(join(PROJECTS_DIR, id, "tasks.json")).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0].id;
  if (!chosen) throw new Error(`proyecto ${args.project} no encontrado (hay: ${ids.join(", ")})`);
  return { file: join(PROJECTS_DIR, chosen, "tasks.json"), projectId: chosen };
}

/** El checkout del proyecto, buscando `project_id` en los `.climier.json` de `~/dev`. */
function resolveProjectRoot(projectId) {
  const dev = join(homedir(), "dev");
  if (!existsSync(dev)) return null;
  for (const entry of readdirSync(dev)) {
    const config = join(dev, entry, ".climier.json");
    if (!existsSync(config)) continue;
    try {
      if (JSON.parse(readFileSync(config, "utf8")).project_id === projectId) return join(dev, entry);
    } catch {
      /* config ilegible: se ignora */
    }
  }
  return null;
}

// ─── Derivación (espejo de `isSatisfied` / `derivedStatus` / `isTaskReady`) ──────────────────

function edgeIndex(edges) {
  const incoming = new Map();
  const supersededBy = new Map();
  for (const edge of edges) {
    if (edge.type === "BLOCKS") {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to).push(edge.from);
    } else if (edge.type === "SUPERSEDES") {
      const current = supersededBy.get(edge.to);
      if (!current || edge.from < current) supersededBy.set(edge.to, edge.from);
    }
  }
  return { incoming, supersededBy };
}

function isSatisfied(nodes, index, id, seen = new Set()) {
  const node = nodes[id];
  if (!node || node.kind === "knowledge" || seen.has(id)) return false;
  const status = node.status ?? "open";
  const terminal = node.subkind === "task" ? TERMINAL_TASK_STATUSES : new Set(["resolved"]);
  if (terminal.has(status)) return true;
  const canceledLike = node.subkind === "task" ? "canceled" : "superseded";
  if (status !== canceledLike) return false;
  const next = index.supersededBy.get(id);
  return next ? isSatisfied(nodes, index, next, new Set([...seen, id])) : false;
}

function derivedStatus(nodes, index, id) {
  const node = nodes[id];
  if (!node) return "unknown";
  const status = node.status ?? "open";
  if (node.kind === "knowledge") return status === "deprecated" ? "canceled" : "ready";
  if (["in_progress", "submitted", "done", "archived", "canceled", "resolved", "superseded"].includes(status)) return status;
  if (node.subkind === "gate") return "open";
  if (node.backlog === true) return "backlog";
  const clean = (index.incoming.get(id) ?? []).every((from) => isSatisfied(nodes, index, from));
  return clean ? "ready" : "blocked";
}

// ─── Armado del snapshot ─────────────────────────────────────────────────────────────────────

/** Orden de campos estable: los del contrato primero, lo que climier agregue después y ordenado. */
const NODE_KEY_ORDER = [
  "id", "kind", "subkind", "title", "body", "acceptance", "definition", "status", "backlog",
  "initiative", "domain", "tags", "refs", "claim", "revision", "purpose", "resolution_mode",
  "resolution", "notes", "meta", "note", "done_by", "done_at", "submitted_by", "submitted_at",
  "accepted_by", "accepted_at", "knowledge_type", "mitigation", "scope", "deprecation_reason",
  "deprecated_at", "deprecated_by",
];

/**
 * El contrato declara opcional lo que no está (`campo?: string`), no lo nulo. El state file del CLI
 * escribe `null` en los campos que todavía no se llenaron (`claim`, `submitted_by`, `accepted_at`…),
 * y eso no es asignable a `string | undefined`. Se omite la clave nula en vez de traducirla: para
 * todos esos campos la ausencia y el nulo significan lo mismo, y así el artefacto cumple el contrato
 * sin que nadie tenga que adivinar en la frontera.
 */
function orderedNode(node) {
  const out = {};
  for (const key of NODE_KEY_ORDER) if (node[key] !== undefined && node[key] !== null) out[key] = node[key];
  for (const key of Object.keys(node).sort()) if (out[key] === undefined && node[key] !== null) out[key] = node[key];
  return out;
}

function build({ stateFile, projectId, logTail }) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const rawNodes = state.nodes ?? {};
  const edges = [...(state.edges ?? [])].sort((a, b) =>
    a.from === b.from ? (a.to === b.to ? String(a.type).localeCompare(String(b.type)) : a.to.localeCompare(b.to)) : a.from.localeCompare(b.from),
  );
  const log = state.log ?? [];

  const nodes = {};
  for (const id of Object.keys(rawNodes).sort()) nodes[id] = orderedNode(rawNodes[id]);

  // `last_activity`: la última entrada del log que toca el nodo.
  const lastActivity = {};
  for (const entry of log) {
    const id = entry.node ?? entry.node_id;
    if (!id || !nodes[id]) continue;
    const current = lastActivity[id];
    if (!current || String(entry.ts) >= String(current.ts)) {
      lastActivity[id] = { action: entry.action, agent: entry.agent, ts: entry.ts, ...(entry.note ? { note: entry.note } : {}) };
    }
  }

  // `recent_activity`: la cola por nodo, sin repetir entradas que tocan varios nodos.
  const byNode = new Map();
  log.forEach((entry, index) => {
    const id = entry.node ?? entry.node_id;
    if (!id || !nodes[id]) return;
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(index);
  });
  const kept = new Set();
  for (const indexes of byNode.values()) for (const index of indexes.slice(-logTail)) kept.add(index);
  const recentActivity = [...kept]
    .sort((a, b) => a - b)
    .map((index) => {
      const entry = log[index];
      const id = entry.node ?? entry.node_id;
      return {
        ts: entry.ts,
        agent: entry.agent,
        action: entry.action,
        node_id: id,
        node_title: nodes[id]?.title ?? id,
        ...(entry.note ? { note: entry.note } : {}),
      };
    });

  // Pools derivados + resumen. La UI los recalcula, pero el snapshot debe estar completo.
  const index = edgeIndex(edges);
  const derived = { ready: [], blocked: [], backlog: [], openGates: [], submitted: [] };
  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    if (node.kind !== "resolvable") continue;
    const status = derivedStatus(nodes, index, id);
    if (node.subkind === "gate") {
      if (status === "open") derived.openGates.push(id);
      continue;
    }
    if (status === "ready") derived.ready.push(id);
    else if (status === "blocked") derived.blocked.push(id);
    else if (status === "backlog") derived.backlog.push(id);
    else if (status === "submitted") derived.submitted.push(id);
  }
  for (const key of Object.keys(derived)) derived[key].sort();

  const summary = { total: 0, tasks: 0, gates: 0, knowledge: 0, edges: 0, initiatives: 0 };
  for (const key of Object.keys(summary)) summary[key] = 0;
  for (const node of Object.values(nodes)) {
    summary.total += 1;
    if (node.kind === "knowledge") summary.knowledge += 1;
    else if (node.subkind === "gate") summary.gates += 1;
    else if (node.subkind === "task") summary.tasks += 1;
  }
  summary.edges = edges.length;
  summary.initiatives = Object.keys(state.initiatives ?? {}).length;
  for (const [status, count] of Object.entries(countBy(Object.values(nodes), (node) => node.status ?? "open"))) {
    summary[`status_${status}`] = count;
  }
  for (const [type, count] of Object.entries(countBy(edges, (edge) => edge.type))) {
    summary[`edge_${type}`] = count;
  }

  const initiatives = {};
  for (const key of Object.keys(state.initiatives ?? {}).sort()) initiatives[key] = state.initiatives[key];

  return {
    project: {
      root: resolveProjectRoot(projectId) ?? dirname(stateFile),
      state_file: stateFile,
      initialized: true,
      project_id: projectId,
    },
    generated_at: new Date(statSync(stateFile).mtimeMs).toISOString(),
    source_revision: state.revision ?? null,
    initiatives,
    nodes,
    edges,
    derived,
    last_activity: lastActivity,
    summary,
    alerts: [],
    recent_activity: recentActivity,
  };
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const { file: stateFile, projectId } = resolveStateFile(args);
const snapshot = build({ stateFile, projectId, logTail: args.logTail });
const json = `${JSON.stringify(snapshot)}\n`;
writeFileSync(args.out, json);

const bytes = Buffer.byteLength(json);
const digest = createHash("sha256").update(json).digest("hex").slice(0, 12);
const { summary } = snapshot;
console.log(
  JSON.stringify(
    {
      ok: true,
      out: args.out,
      project_id: projectId,
      state_file: stateFile,
      generated_at: snapshot.generated_at,
      sha256_12: digest,
      bytes,
      mb: Number((bytes / 1e6).toFixed(2)),
      nodes: summary.total,
      tasks: summary.tasks,
      gates: summary.gates,
      knowledge: summary.knowledge,
      edges: summary.edges,
      initiatives: summary.initiatives,
      derived: {
        ready: snapshot.derived.ready.length,
        blocked: snapshot.derived.blocked.length,
        backlog: snapshot.derived.backlog.length,
        openGates: snapshot.derived.openGates.length,
        submitted: snapshot.derived.submitted.length,
      },
      last_activity: Object.keys(snapshot.last_activity).length,
      recent_activity: snapshot.recent_activity.length,
      nodes_without_last_activity: summary.total - Object.keys(snapshot.last_activity).length,
    },
    null,
    2,
  ),
);
