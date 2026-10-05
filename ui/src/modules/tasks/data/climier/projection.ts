/**
 * Proyección `snapshot de climier → view models del board`.
 *
 * Es la única traducción entre el modelo de climier y la UI. Las reglas son las mismas que el
 * read-model del CLI (`src/read-model/`, `src/providers/`), reimplementadas acá en puro y sin
 * filesystem para no cruzar repos ni duplicar I/O:
 *
 *  - `derivedStatus` espeja `statusOfV2`: los estados terminales mandan, `backlog` gana sobre
 *    `ready`, y `ready`/`blocked` salen de `BLOCKS` satisfechos.
 *  - `isSatisfied` espeja `isSatisfiedV2`: task `done`/`archived` satisface; `canceled` sigue la
 *    cadena de `SUPERSEDES`; gate `resolved` satisface y `superseded` sigue su cadena.
 *  - `blockingForNode`, `dependentsForNode`, `knowledgeForNode` y `refsOf` espejan las mismas
 *    proyecciones que expone `GET /api/node/:id`.
 *
 * Nada de esto lee red ni estado global: entra un `ClimierSnapshot`, sale un `Task`/`TaskDetail`.
 * Cuando el dato real llegue (server de climier o fixture), es el mismo camino.
 */
import type {
  ClimierBlocker,
  ClimierDependent,
  ClimierEdge,
  ClimierKnowledgeMatch,
  ClimierLogEntry,
  ClimierNode,
  ClimierRef,
  ClimierSnapshot,
} from "./contract";
import type {
  BoardStatus,
  Task,
  TaskActivityEntry,
  TaskActivityKind,
  TaskBlocker,
  TaskDependent,
  TaskDetail,
  TaskKnowledge,
  TaskNote,
  TaskReference,
  TaskReferenceKind,
} from "../../types";

const CLAIM_STALE_MS = 2 * 60 * 60 * 1000;
const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);
const NON_READY_TASK_STATUSES = new Set(["in_progress", "submitted", "done", "archived", "canceled"]);

// ─── Derivación de estado ───────────────────────────────────────────────────────────────────

function nodesOf(snapshot: ClimierSnapshot): Record<string, ClimierNode> {
  return snapshot.nodes ?? {};
}

function edgesOf(snapshot: ClimierSnapshot): ClimierEdge[] {
  return Array.isArray(snapshot.edges) ? snapshot.edges : [];
}

function supersededBy(snapshot: ClimierSnapshot, id: string): string | null {
  return edgesOf(snapshot)
    .filter((edge) => edge.type === "SUPERSEDES" && edge.to === id)
    .map((edge) => edge.from)
    .sort()[0] ?? null;
}

/** ¿El node satisface un `BLOCKS`? Misma semántica que `isSatisfiedV2`. */
export function isSatisfied(snapshot: ClimierSnapshot, id: string, seen = new Set<string>()): boolean {
  const node = nodesOf(snapshot)[id];
  if (!node || node.kind === "knowledge" || seen.has(id)) return false;
  const status = node.status ?? "open";
  if (node.subkind === "task") {
    if (TERMINAL_TASK_STATUSES.has(status)) return true;
    if (status !== "canceled") return false;
    const next = supersededBy(snapshot, id);
    return next ? isSatisfied(snapshot, next, new Set([...seen, id])) : false;
  }
  if (node.subkind === "gate") {
    if (status === "resolved") return true;
    if (status !== "superseded") return false;
    const next = supersededBy(snapshot, id);
    return next ? isSatisfied(snapshot, next, new Set([...seen, id])) : false;
  }
  return false;
}

function isTaskReady(snapshot: ClimierSnapshot, id: string): boolean {
  const node = nodesOf(snapshot)[id];
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") return false;
  const status = node.status ?? "open";
  if (NON_READY_TASK_STATUSES.has(status) || node.backlog === true) return false;
  return edgesOf(snapshot)
    .filter((edge) => edge.type === "BLOCKS" && edge.to === id)
    .every((edge) => isSatisfied(snapshot, edge.from));
}

/** Estado derivado de un node, en el vocabulario del board. */
export function derivedStatus(snapshot: ClimierSnapshot, id: string): BoardStatus | "unknown" {
  const node = nodesOf(snapshot)[id];
  if (!node) return "unknown";
  const status = node.status ?? "open";
  if (node.kind === "knowledge") return status === "deprecated" ? "canceled" : "ready";
  if (["in_progress", "submitted", "done", "archived", "canceled", "resolved", "superseded"].includes(status)) {
    return status as BoardStatus;
  }
  if (node.subkind === "gate") return "open";
  if (node.backlog === true) return "backlog";
  return isTaskReady(snapshot, id) ? "ready" : "blocked";
}

// ─── Satisfacción, vecinos, knowledge y refs ────────────────────────────────────────────────

/** Blockers entrantes (`BLOCKS`), con `satisfied` ya calculado. */
export function blockingForNode(snapshot: ClimierSnapshot, id: string): ClimierBlocker[] {
  return edgesOf(snapshot)
    .filter((edge) => edge.type === "BLOCKS" && edge.to === id)
    .map((edge) => ({ edge_type: edge.type, node: nodesOf(snapshot)[edge.from], satisfied: isSatisfied(snapshot, edge.from) }))
    .filter((blocker): blocker is ClimierBlocker => Boolean(blocker.node));
}

/** Vecinos salientes de cualquier tipo (lo que depende de este node). */
export function dependentsForNode(snapshot: ClimierSnapshot, id: string): ClimierDependent[] {
  return edgesOf(snapshot)
    .filter((edge) => edge.from === id)
    .map((edge) => ({ edge_type: edge.type, node: nodesOf(snapshot)[edge.to] }))
    .filter((dependent): dependent is ClimierDependent => Boolean(dependent.node));
}

export function scopeMatches(node: ClimierNode, knowledge: ClimierNode): string[] {
  const scope = knowledge.scope ?? {};
  const matches: string[] = [];
  if (node.id && (scope.node_ids ?? []).includes(node.id)) matches.push("node");
  if (node.domain && (scope.domains ?? []).includes(node.domain)) matches.push("domain");
  if ((node.tags ?? []).some((tag) => (scope.tags ?? []).includes(tag))) matches.push("tag");
  if (node.initiative && (scope.initiatives ?? []).includes(node.initiative)) matches.push("initiative");
  return matches;
}

/** Knowledge activo, deprecated o superseded que aplica al node, ordenado por especificidad. */
export function knowledgeForNode(snapshot: ClimierSnapshot, id: string): ClimierKnowledgeMatch[] {
  const node = nodesOf(snapshot)[id];
  if (!node) return [];
  const rank: Record<string, number> = { node: 4, domain: 3, tag: 2, initiative: 1 };
  return Object.values(nodesOf(snapshot))
    .filter((candidate) => candidate.kind === "knowledge")
    .map((candidate) => ({ ...candidate, scope_matches: scopeMatches(node, candidate) }))
    .filter((candidate) => candidate.scope_matches.length > 0)
    .sort((left, right) => {
      const score = (item: ClimierKnowledgeMatch) => Math.max(...item.scope_matches.map((match) => rank[match] ?? 0));
      return score(right) - score(left) || left.id.localeCompare(right.id);
    });
}

/** Referencias explícitas del node. */
function explicitRefs(node: ClimierNode): ClimierRef[] {
  return (node.refs ?? [])
    .map((ref) => {
      if (typeof ref === "string") return { target: ref, type: "doc", source: "explicit" };
      if (ref && typeof ref === "object" && ref.target) {
        return { target: String(ref.target), type: String(ref.type ?? "doc"), source: String(ref.source ?? "explicit") };
      }
      return null;
    })
    .filter((ref): ref is ClimierRef => Boolean(ref));
}

const DOC_REF = /(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g;

/** Refs explícitas + docs detectados en body/acceptance/notes (espeja `refsOf` del server). */
export function refsOf(node: ClimierNode): ClimierRef[] {
  const out: ClimierRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ClimierRef) => {
    const key = `${ref.target}::${ref.type}::${ref.source}`;
    if (!ref.target || seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  explicitRefs(node).forEach(push);
  for (const [source, text] of [["body", node.body], ["acceptance", node.acceptance]] as const) {
    for (const match of String(text ?? "").matchAll(DOC_REF)) push({ target: match[0], type: "doc", source });
  }
  for (const note of node.notes ?? []) {
    for (const match of String(note.text ?? "").matchAll(DOC_REF)) push({ target: match[0], type: "doc", source: "notes" });
  }
  return out;
}

// ─── Progreso ───────────────────────────────────────────────────────────────────────────────

/** Avance de una task según su estado derivado. */
export function taskProgress(status: BoardStatus): number {
  switch (status) {
    case "in_progress": return 50;
    case "submitted": return 85;
    case "done": return 100;
    case "archived": return 100;
    default: return 0;
  }
}

/** Trabajo descartado: ni hecho ni en juego, así que no entra en el progreso. */
const DROPPED = new Set<BoardStatus>(["canceled"]);

/**
 * Progreso de un grupo: avance del **trabajo vigente**.
 *
 * Promedia el `progress` de las tasks no canceladas, así que lo terminado cuenta (una `done`
 * aporta 100) en vez de ignorarse: contar únicamente lo abierto hacía que una iniciativa con 89
 * `done` y una `open` mostrara 0%. Las canceladas quedan fuera porque no son trabajo hecho ni
 * trabajo en juego. Un grupo vacío o sin trabajo vigente queda en 0.
 */
export function groupProgress(tasks: Task[]): number {
  const live = tasks.filter((task) => !DROPPED.has(task.status));
  if (!live.length) return 0;
  return Math.round(live.reduce((total, task) => total + task.progress, 0) / live.length);
}

// ─── Proyección de nodos ────────────────────────────────────────────────────────────────────

function firstParagraph(body: string | undefined): string {
  return String(body ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
}

function paragraphs(body: string | undefined): string[] {
  return String(body ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function claimOf(node: ClimierNode): { by: string | null; stale: boolean } {
  const by = node.claim?.by ?? null;
  if (!by) return { by: null, stale: false };
  const at = node.claim?.at;
  const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
  return { by, stale: Number.isFinite(ms) && Date.now() - ms > CLAIM_STALE_MS };
}

/** Convierte un node de climier en un `Task` del board. */
export function taskFromNode(snapshot: ClimierSnapshot, node: ClimierNode): Task {
  const status = derivedStatus(snapshot, node.id);
  const blockers = blockingForNode(snapshot, node.id);
  const claim = claimOf(node);
  return {
    id: node.id,
    kind: node.subkind === "gate" ? "gate" : "task",
    title: node.title || node.id,
    description: firstParagraph(node.body),
    status: status === "unknown" ? "blocked" : status,
    tags: node.tags ?? [],
    notes: (node.notes ?? []).length,
    refs: refsOf(node).length,
    blockers: blockers.filter((blocker) => !blocker.satisfied).length,
    dependents: dependentsForNode(snapshot, node.id).length,
    updatedAt: snapshot.last_activity?.[node.id]?.ts ?? "",
    progress: taskProgress(status === "unknown" ? "blocked" : status),
    initiative: node.initiative ?? null,
    domain: node.domain ?? null,
    claimedBy: claim.by,
    claimStale: claim.stale,
    revision: node.revision ?? 0,
    backlog: node.backlog === true,
    purpose: node.subkind === "gate" ? node.purpose : undefined,
  };
}

/** Todas las tasks del snapshot (incluye done/canceled/archived). */
export function projectTasks(snapshot: ClimierSnapshot): Task[] {
  return Object.values(nodesOf(snapshot))
    .filter((node) => node.kind === "resolvable" && node.subkind === "task")
    .map((node) => taskFromNode(snapshot, node));
}

/** Sólo las gates **pendientes** (`open`), que son las que se muestran en el board. */
export function projectGates(snapshot: ClimierSnapshot): Task[] {
  return Object.values(nodesOf(snapshot))
    .filter((node) => node.kind === "resolvable" && node.subkind === "gate" && (node.status ?? "open") === "open")
    .map((node) => taskFromNode(snapshot, node));
}

export function projectBoard(snapshot: ClimierSnapshot): { tasks: Task[]; gates: Task[] } {
  return { tasks: projectTasks(snapshot), gates: projectGates(snapshot) };
}

// ─── Actividad y detalle ────────────────────────────────────────────────────────────────────

const ACTION_KIND: Record<string, TaskActivityKind> = {
  "add-node": "created",
  "add-task": "created",
  "add-note": "comment",
  take: "claim",
  release: "release",
  "task.submit": "submit",
  "task.accept": "accept",
  "task.reject": "reject",
  update: "update",
  resolve: "resolve",
  cancel: "cancel",
  reopen: "reopen",
  supersede: "supersede",
  "add-edge": "link",
  "edge.remove": "link",
};

const ACTION_TEXT: Record<string, string> = {
  "add-node": "created the task",
  "add-task": "created the task",
  "add-note": "commented",
  take: "claimed it",
  release: "released the claim",
  "task.submit": "submitted it for validation",
  "task.accept": "accepted it",
  "task.reject": "rejected it",
  update: "updated it",
  resolve: "resolved it",
  cancel: "canceled it",
  reopen: "reopened it",
  supersede: "superseded it",
  "add-edge": "linked a node",
  "edge.remove": "removed a link",
};

/** Etiqueta relativa corta (`"3h"`, `"2d"`). El fixture usa fechas reales, así que se calcula. */
function relativeTime(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function logNodeId(entry: ClimierLogEntry): string | null {
  return entry.node_id ?? entry.node ?? entry.task ?? null;
}

/** Historial de un node a partir del log del snapshot. */
export function activityForNode(snapshot: ClimierSnapshot, id: string): TaskActivityEntry[] {
  const entries = [...(snapshot.recent_activity ?? [])]
    .filter((entry) => logNodeId(entry) === id)
    .sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  return entries.map((entry, index) => {
    const kind = ACTION_KIND[entry.action] ?? "update";
    return {
      id: `${id}-${index}`,
      kind,
      author: entry.agent || "unknown",
      text: ACTION_TEXT[entry.action] ?? entry.action,
      at: relativeTime(entry.ts),
      comment: kind === "comment" && entry.note ? entry.note : undefined,
    };
  });
}

function toBlocker(blocker: ClimierBlocker): TaskBlocker {
  const status = blocker.node.status ?? "open";
  return {
    id: blocker.node.id,
    title: blocker.node.title || blocker.node.id,
    kind: blocker.node.kind === "knowledge" ? "knowledge" : (blocker.node.subkind ?? "task"),
    status: status as BoardStatus,
    satisfied: blocker.satisfied,
  };
}

function toDependent(dependent: ClimierDependent): TaskDependent {
  const status = dependent.node.status ?? "open";
  return {
    id: dependent.node.id,
    title: dependent.node.title || dependent.node.id,
    kind: dependent.node.kind === "knowledge" ? "knowledge" : (dependent.node.subkind ?? "task"),
    status: status as BoardStatus,
    edgeType: dependent.edge_type,
  };
}

function toKnowledge(match: ClimierKnowledgeMatch): TaskKnowledge {
  return {
    id: match.id,
    title: match.title || match.id,
    body: match.body ?? "",
    knowledgeType: match.knowledge_type ?? "note",
    status: match.status === "deprecated" || match.status === "superseded" ? match.status : "active",
    scopeMatches: match.scope_matches,
  };
}

function refKind(ref: ClimierRef): TaskReferenceKind {
  if (/^https?:\/\//.test(ref.target) || ref.type === "url") return "link";
  if (/\.(md|txt|pdf)$/i.test(ref.target) || ref.type === "doc") return "doc";
  return "file";
}

function toReferences(refs: ClimierRef[]): TaskReference[] {
  return refs.map((ref) => ({
    id: `${ref.target}::${ref.source}`,
    name: ref.target.split("/").pop() ?? ref.target,
    source: ref.source,
    kind: refKind(ref),
  }));
}

function toNotes(node: ClimierNode): TaskNote[] {
  return (node.notes ?? []).map((note, index) => ({
    id: `${node.id}-note-${index}`,
    agent: note.agent || "unknown",
    text: note.text,
    at: note.ts,
  }));
}

/** Detalle completo de un node, derivado del snapshot (misma información que `/api/node/:id`). */
export function projectTaskDetail(snapshot: ClimierSnapshot, id: string): TaskDetail | undefined {
  const node = nodesOf(snapshot)[id];
  if (!node) return undefined;
  const claim = claimOf(node);
  return {
    task: taskFromNode(snapshot, node),
    body: paragraphs(node.body),
    acceptance: node.acceptance ?? null,
    initiative: node.initiative ?? null,
    domain: node.domain ?? null,
    claimedBy: claim.by,
    blockers: blockingForNode(snapshot, id).map(toBlocker),
    dependents: dependentsForNode(snapshot, id).map(toDependent),
    knowledge: knowledgeForNode(snapshot, id).map(toKnowledge),
    refs: toReferences(refsOf(node)),
    activity: activityForNode(snapshot, id),
    notes: toNotes(node),
  };
}

// ─── Vocabulario para filtros ───────────────────────────────────────────────────────────────

/** Agentes que tienen un claim en el board, ordenados. */
export function claimedAgents(snapshot: ClimierSnapshot): string[] {
  return [...new Set(projectTasks(snapshot).map((task) => task.claimedBy).filter((value): value is string => Boolean(value)))].sort();
}

/** Tags presentes en el board, ordenados. */
export function boardTags(snapshot: ClimierSnapshot): string[] {
  return [...new Set(projectTasks(snapshot).flatMap((task) => task.tags))].sort();
}
