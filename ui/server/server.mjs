// climier UI local server.
// Live projection of a climier project's state. The browser never touches
// the state file: this server (running on the user's machine) is the only
// reader, and it uses the canonical read-model plus storage helpers
// (../../src/read-model/index.mjs, ../../src/state.mjs) so the projection can't drift.
// Every request re-reads the state file, so CLI mutations show up in real
// time (the frontend polls /api/snapshot); no restart or reload needed.
//
// Run via `climier ui` (see ../../src/commands/ui.mjs) or directly:
//   node server/server.mjs --project <dir> [--port N]
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { readState, stateFile } from "../../src/state.mjs";
import { projectMetaFile } from "../../src/storage/paths.mjs";
import {
  derive,
  statusOf,
  knowledgeForNode,
  blockingForNode,
  informingForNode,
  isCurrent,
  supersededBy,
} from "../../src/read-model/index.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.dirname(SERVER_DIR);
const DIST_DIR = path.join(UI_DIR, "dist");

const DEFAULT_PORT = 7373;
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

// --- small pure helpers (mirroring CLI views, no I/O) ----------------------

function inlineNode(state, id) {
  const node = state.nodes[id];
  if (!node) {
    return { id, status: "missing", is_current: true, superseded_by: null };
  }
  return {
    ...node,
    is_current: isCurrent(state, id),
    superseded_by: supersededBy(state, id),
  };
}

function dependentsOf(state, id) {
  return (state.edges || [])
    .filter((e) => e.from === id)
    .map((e) => ({ edge_type: e.type, node: inlineNode(state, e.to) }));
}

function logForNode(state, id) {
  return (state.log || []).filter((e) => e.node === id || e.task === id);
}

// Coerce a `claim.at` / `claimed_at` value to epoch-ms, regardless of
// whether it's already a number, an ISO string, or missing. Returns null
// when the value can't be coerced. Mirrors src/commands/status.mjs.
function claimAtMs(node) {
  if (!node) return null;
  const at = (node.claim && node.claim.at) || node.claimed_at;
  if (at == null) return null;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// Stale-claim detection is intentionally restricted to in_progress tasks
// (the previous version looked at any node with a claim, including done
// tasks — which never age out and cluttered alerts).
function detectStaleClaims(state, staleMs = DEFAULT_STALE_MS) {
  const now = Date.now();
  const out = [];
  for (const node of Object.values(state.nodes || {})) {
    if (node.kind !== "resolvable" || node.subkind !== "task") continue;
    if ((node.status || "open") !== "in_progress") continue;
    const at = claimAtMs(node);
    if (at === null) continue;
    const by = node.claim && node.claim.by;
    if (!by) continue;
    const age = now - at;
    if (age > staleMs) {
      out.push({
        node_id: node.id,
        title: node.title,
        claimed_by: by,
        age_ms: age,
      });
    }
  }
  return out;
}

// Read the project_id from the repo-local metadata file (.climier.json).
// Returns null if missing or unreadable — that's fine, the state file is
// still the source of truth for everything else.
async function readProjectId(projectDir) {
  try {
    const raw = await fs.readFile(projectMetaFile(projectDir), "utf8");
    const meta = JSON.parse(raw);
    if (meta && typeof meta.project_id === "string" && meta.project_id.trim()) {
      return meta.project_id;
    }
  } catch {
    /* .climier.json absent or corrupt: surface as null */
  }
  return null;
}

function zeroSummary() {
  // The contract: missing metrics are 0, never undefined. Views can rely
  // on every key being present.
  return {
    ready: 0,
    in_progress: 0,
    blocked: 0,
    backlog: 0,
    placeholders: 0,
    stale: 0,
    open_gates: 0,
    open_decisions: 0,
    done: 0,
    archived: 0,
    canceled: 0,
    resolved_gates: 0,
    superseded: 0,
    active_knowledge: 0,
    deprecated_knowledge: 0,
    total_nodes: 0,
  };
}

function summaryOf(state, derived, staleCount) {
  const nodes = Object.values(state.nodes || {});
  const tasks = nodes.filter((n) => n.kind === "resolvable" && n.subkind === "task");
  const gates = nodes.filter((n) => n.kind === "resolvable" && n.subkind === "gate");
  const knowledge = nodes.filter((n) => n.kind === "knowledge");
  return {
    ready: derived.ready.length,
    in_progress: tasks.filter((n) => (n.status || "open") === "in_progress").length,
    blocked: derived.blocked.length,
    backlog: derived.backlog.length,
    placeholders: tasks.filter((n) => n.placeholder === true).length,
    stale: staleCount,
    open_gates: derived.openGates.length,
    open_decisions: gates.filter((n) => (n.status || "open") === "open" && n.purpose === "decision").length,
    done: tasks.filter((n) => n.status === "done").length,
    archived: tasks.filter((n) => n.status === "archived").length,
    canceled: tasks.filter((n) => n.status === "canceled").length,
    resolved_gates: gates.filter((n) => n.status === "resolved").length,
    superseded: nodes.filter((n) => n.status === "superseded").length,
    active_knowledge: knowledge.filter((n) => (n.status || "active") !== "deprecated").length,
    deprecated_knowledge: knowledge.filter((n) => n.status === "deprecated").length,
    total_nodes: nodes.length,
  };
}

// Per-initiative breakdown grouped by kind (tasks/gates/knowledge) so
// views don't have to re-derive the split and don't conflate kinds when
// computing totals.
function initiativeSummary(state) {
  const by = {};
  for (const node of Object.values(state.nodes || {})) {
    if (!node.initiative) continue;
    const slot = (by[node.initiative] = by[node.initiative] || {
      initiative: node.initiative,
      total: 0,
      by_kind: {
        tasks: { total: 0, ready: 0, in_progress: 0, blocked: 0, backlog: 0, done: 0, archived: 0, canceled: 0 },
        gates: { total: 0, open: 0, resolved: 0, superseded: 0 },
        knowledge: { total: 0, active: 0, deprecated: 0 },
      },
    });
    slot.total += 1;
    if (node.kind === "resolvable" && node.subkind === "task") {
      const t = slot.by_kind.tasks;
      t.total += 1;
      const status = node.status || "open";
      if (status === "in_progress") t.in_progress += 1;
      else if (status === "done") t.done += 1;
      else if (status === "archived") t.archived += 1;
      else if (status === "canceled") t.canceled += 1;
      else if (node.backlog === true) t.backlog += 1;
      else if (status === "open") {
        // The server's derived pools are ready/blocked; statusOf keeps
        // a single source of truth.
        const derivedStatus = statusOf({ snapshot: state, id: node.id });
        if (derivedStatus === "ready") t.ready += 1;
        else if (derivedStatus === "blocked") t.blocked += 1;
      }
    } else if (node.kind === "resolvable" && node.subkind === "gate") {
      const g = slot.by_kind.gates;
      g.total += 1;
      const status = node.status || "open";
      if (status === "resolved") g.resolved += 1;
      else if (status === "superseded") g.superseded += 1;
      else g.open += 1;
    } else if (node.kind === "knowledge") {
      const k = slot.by_kind.knowledge;
      k.total += 1;
      if ((node.status || "active") === "deprecated") k.deprecated += 1;
      else k.active += 1;
    }
  }
  return Object.values(by).sort((a, b) => b.total - a.total);
}

// Normalize a log entry: expose the node id as `node_id`, decorate with
// `node_title` from the current state (the log entry itself never carries
// the title). For backward compatibility, callers that still expect
// `node` or `task` get aliased fields too.
function normalizeActivityEntry(state, entry) {
  const id = entry.node || entry.task || null;
  const node = id ? state.nodes[id] : null;
  const out = {
    ...entry,
    node_id: id,
    node_title: node ? node.title || null : null,
  };
  return out;
}

function recentActivity(state, limit = 20) {
  const log = state.log || [];
  return log.slice(-limit).reverse().map((e) => normalizeActivityEntry(state, e));
}

// Apply the activity filters to a log slice. The same predicate is used
// for the response page AND for the facets, so a UI that narrows by `q`
// sees the action/agent counts shrink in lockstep. Empty/undefined
// filters are no-ops.
function applyActivityFilters(state, entries, filters) {
  const { action, agent, node, q, initiative } = filters;
  let out = entries;
  if (action) out = out.filter((e) => e.action === action);
  if (agent) out = out.filter((e) => e.agent === agent);
  if (node) out = out.filter((e) => e.node === node || e.task === node);
  if (initiative) {
    out = out.filter((e) => {
      const id = e.node || e.task;
      if (!id) return false;
      const n = state.nodes[id];
      return !!n && n.initiative === initiative;
    });
  }
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((e) => {
      const id = e.node || e.task || null;
      const n = id ? state.nodes[id] : null;
      const haystack = [
        e.note || "",
        e.agent || "",
        e.action || "",
        id || "",
        n ? n.title || "" : "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }
  return out;
}

// Build facets over a log slice. We deliberately do NOT use a fixed list
// of actions: add-edge and any future / custom action surface in the
// dropdown because they are derived from the log itself. Counts include
// every entry that passes the filter; the most common values come first.
function buildFacets(state, entries, filters) {
  const countBy = (arr, key) => {
    const m = new Map();
    for (const e of arr) {
      const v = e[key];
      if (v == null) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()]
      .map(([k, count]) => ({ [key]: k, count }))
      .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
  };
  // Actions facet: re-apply every filter EXCEPT the action filter, so
  // the dropdown shows the actions still reachable when the user changes
  // the current action selection.
  const actionEntries = applyActivityFilters(state, entries, { ...filters, action: undefined });
  // Agents facet: same trick, leave the agent filter off.
  const agentEntries = applyActivityFilters(state, entries, { ...filters, agent: undefined });
  return {
    actions: countBy(actionEntries, "action"),
    agents: countBy(agentEntries, "agent"),
  };
}

function activityPage(state, limit, offset, filters = {}) {
  const filtered = applyActivityFilters(state, state.log || [], filters);
  const total = filtered.length;
  const start = Math.max(0, total - limit - offset);
  const end = Math.max(0, total - offset);
  const page = filtered.slice(start, end).reverse().map((e) => normalizeActivityEntry(state, e));
  return {
    entries: page,
    total,
    limit,
    offset,
    facets: buildFacets(state, state.log || [], filters),
  };
}

// Refs are always returned as structured objects {target, type, source}.
// - explicit `node.refs` entries that are already objects pass through
//   (with default type/source when missing);
// - bare-string entries (legacy shape) are wrapped;
// - markdown paths detected in body/definition/acceptance/notes are
//   wrapped as type='doc', source=<the field they came from>.
function normalizeRef(input, defaults = {}) {
  if (input == null) return null;
  if (typeof input === "string") {
    return { target: input, type: defaults.type || "doc", source: defaults.source || "explicit" };
  }
  if (typeof input === "object") {
    return {
      target: String(input.target || ""),
      type: String(input.type || defaults.type || "doc"),
      source: String(input.source || defaults.source || "explicit"),
    };
  }
  return null;
}

function refsOf(node) {
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    const normalized = normalizeRef(ref);
    if (!normalized || !normalized.target) return;
    const key = `${normalized.target}::${normalized.type}::${normalized.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  for (const ref of node.refs || []) push(ref);
  const sources = [
    ["body", node.body],
    ["definition", node.definition],
    ["acceptance", node.acceptance],
  ];
  for (const [source, text] of sources) {
    if (!text) continue;
    const re = /(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g;
    for (const m of String(text).matchAll(re)) {
      push({ target: m[0], type: "doc", source });
    }
  }
  for (const note of node.notes || []) {
    if (!note || !note.text) continue;
    const re = /(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g;
    for (const m of String(note.text).matchAll(re)) {
      push({ target: m[0], type: "doc", source: "notes" });
    }
  }
  return out;
}

// --- server ----------------------------------------------------------------

export async function start({ projectDir, port = DEFAULT_PORT, log = console.error }) {
  // Fail fast at boot on a corrupt state, like before. After that, every
  // request re-reads the live state file so the UI tracks CLI mutations in
  // real time: no server restart and no browser reload required.
  const initial = await readState(projectDir).catch((err) => {
    // Corrupt state: surface it clearly instead of serving an empty board.
    throw new Error(`ui: cannot read state for ${projectDir}: ${err.message}`);
  });
  let lastGood = initial;
  let lastProjectId = await readProjectId(projectDir);

  // Fresh read per request. If the file becomes unreadable mid-run, fall
  // back to the last good state and surface a visible alert instead of
  // killing the UI (the snapshot carries the state-read-error alert).
  async function freshState() {
    try {
      lastGood = await readState(projectDir);
      const nextProjectId = await readProjectId(projectDir);
      if (nextProjectId !== lastProjectId) lastProjectId = nextProjectId;
      return { state: lastGood, read_error: null, project_id: lastProjectId };
    } catch (err) {
      return { state: lastGood, read_error: err, project_id: lastProjectId };
    }
  }

  function stateReadAlerts(readError) {
    return readError
      ? [{
          kind: "state-read-error",
          severity: "error",
          code: readError.code || "STATE_READ_ERROR",
          node_id: null,
          message: readError.message,
        }]
      : [];
  }

  function staleAlerts(stale) {
    return stale.map((s) => ({
      kind: "stale-claim",
      severity: "warning",
      node_id: s.node_id,
      claimed_by: s.claimed_by,
      age_ms: s.age_ms,
      message: `${s.node_id} claimed by ${s.claimed_by} is stale (${Math.round(s.age_ms / 60000)}m old)`,
    }));
  }

  const app = express();
  app.use(express.json());

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.get("/api/snapshot", async (req, res) => {
    const { state, read_error, project_id } = await freshState();
    if (!state) {
      return res.json({
        project: { root: projectDir, state_file: stateFile(projectDir), initialized: false, project_id },
        generated_at: new Date().toISOString(),
        initiatives: {},
        nodes: {},
        edges: [],
        derived: { ready: [], blocked: [], backlog: [], openGates: [] },
        initiative_summary: [],
        summary: zeroSummary(),
        alerts: stateReadAlerts(read_error),
        recent_activity: [],
      });
    }
    const derived = derive({ snapshot: state });
    const stale = detectStaleClaims(state);
    const lastActivity = {};
    for (const e of state.log || []) {
      const id = e.node || e.task;
      if (id) lastActivity[id] = { action: e.action, agent: e.agent, ts: e.ts, note: e.note };
    }
    res.json({
      project: {
        root: projectDir,
        state_file: stateFile(projectDir),
        initialized: true,
        project_id,
      },
      generated_at: new Date().toISOString(),
      initiatives: state.initiatives || {},
      nodes: state.nodes || {},
      edges: state.edges || [],
      derived,
      last_activity: lastActivity,
      initiative_summary: initiativeSummary(state),
      summary: summaryOf(state, derived, stale.length),
      alerts: [...stateReadAlerts(read_error), ...staleAlerts(stale)],
      recent_activity: recentActivity(state),
    });
  });

  app.get("/api/node/:id", async (req, res) => {
    const { state } = await freshState();
    if (!state || !state.nodes[req.params.id]) {
      return res.status(404).json({ error: { code: "NODE_NOT_FOUND", message: `node ${req.params.id} not found` } });
    }
    const id = req.params.id;
    const node = state.nodes[id];
    const blocking = blockingForNode(state, id);
    const dependents = dependentsOf(state, id);
    const informing = informingForNode(state, id);
    const knowledge = knowledgeForNode(state, id);
    const history = logForNode(state, id).slice(-50).map((e) => normalizeActivityEntry(state, e));
    res.json({
      node,
      blocking,
      dependents,
      informing,
      knowledge,
      history,
      refs: refsOf(node),
      // Drive the derivation off the same function the CLI uses so the UI
      // can't disagree about what an open gate / blocked task looks like.
      derived_status: statusOf({ snapshot: state, id }),
      is_current: isCurrent(state, id),
      superseded_by: supersededBy(state, id),
    });
  });

  app.get("/api/activity", async (req, res) => {
    const { state } = await freshState();
    const lim = Math.max(0, parseInt(req.query.limit, 10) || 50);
    const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (!state) {
      return res.json({
        entries: [],
        total: 0,
        limit: lim,
        offset: off,
        facets: { actions: [], agents: [] },
      });
    }
    const filters = {
      action: req.query.action || undefined,
      agent: req.query.agent || undefined,
      node: req.query.node || undefined,
      initiative: req.query.initiative || undefined,
      q: req.query.q || undefined,
    };
    res.json(activityPage(state, lim, off, filters));
  });

  app.get("/api/search", async (req, res) => {
    const { state } = await freshState();
    if (!state) return res.json({ tasks: [], gates: [], knowledge: [] });
    const q = String(req.query.q || "").trim().toLowerCase();
    const all = req.query.all === "true";
    if (!q) return res.json({ tasks: [], gates: [], knowledge: [] });
    const match = (n) => {
      if (!all && n.status === "deprecated") return false;
      const hay = [n.id, n.title, n.body, n.domain, n.initiative, (n.tags || []).join(" ")].join("\n").toLowerCase();
      return hay.includes(q);
    };
    const hits = Object.values(state.nodes).filter(match);
    res.json({
      tasks: hits.filter((n) => n.subkind === "task"),
      gates: hits.filter((n) => n.subkind === "gate"),
      knowledge: hits.filter((n) => n.kind === "knowledge"),
    });
  });

  // Static UI (built by vite) with SPA fallback.
  if (await exists(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(DIST_DIR, "index.html"));
    });
  } else {
    app.get("/", (req, res) => {
      res
        .status(200)
        .type("html")
        .send(`<h1>climier ui</h1><p>UI assets not built. Run <code>npm run build</code> inside <code>ui/</code> (or re-run <code>climier ui</code> which builds automatically).</p>`);
    });
  }

  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, "127.0.0.1", () => resolve(srv));
    srv.on("error", (err) => reject(err));
  });
  const url = `http://127.0.0.1:${port}`;
  log(`climier ui listening at ${url} (project: ${projectDir})`);
  return { url, server, state: lastGood };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Direct invocation: node server/server.mjs --project <dir> [--port N]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const projectDir = flag("project") || process.cwd();
  const port = parseInt(flag("port") || String(DEFAULT_PORT), 10);
  start({ projectDir, port }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}