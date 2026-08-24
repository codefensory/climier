// climier UI local server.
// Live projection of a climier project's state. The browser never touches
// the state file: this server (running on the user's machine) is the only
// reader, and it uses the CLI's own pure derivation functions
// (../../src/v2.mjs, ../../src/state.mjs) so the projection can't drift.
// Every request re-reads the state file, so CLI mutations show up in real
// time (the frontend polls /api/snapshot); no restart or reload needed.
//
// Run via `climier ui` (see ../../src/commands/ui.mjs) or directly:
//   node server/server.mjs --project <dir> [--port N]
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { readState, stateFile } from "../../src/state.mjs";
import {
  deriveV2,
  knowledgeForNode,
  blockingForNode,
  informingForNode,
  isCurrent,
  supersededBy,
} from "../../src/v2.mjs";

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

function detectStaleClaims(state, staleMs = DEFAULT_STALE_MS) {
  const now = Date.now();
  const out = [];
  for (const node of Object.values(state.nodes || {})) {
    const claim = node.claim;
    if (!claim || !claim.ts) continue;
    const age = now - new Date(claim.ts).getTime();
    if (age > staleMs) out.push({ id: node.id, title: node.title, claim, age_ms: age });
  }
  return out;
}

function summaryOf(state, derived) {
  const nodes = Object.values(state.nodes || {});
  const resolvables = nodes.filter((n) => n.kind === "resolvable");
  const tasks = resolvables.filter((n) => n.subkind === "task");
  const gates = resolvables.filter((n) => n.subkind === "gate");
  const knowledge = nodes.filter((n) => n.kind === "knowledge");
  return {
    ready: derived.ready.length,
    in_progress: tasks.filter((n) => n.status === "in_progress").length,
    blocked: derived.blocked.length,
    backlog: derived.backlog.length,
    done: tasks.filter((n) => n.status === "done").length,
    canceled: tasks.filter((n) => n.status === "canceled").length,
    open_gates: derived.openGates.length,
    resolved_gates: gates.filter((n) => n.status === "resolved").length,
    superseded: nodes.filter((n) => n.status === "superseded").length,
    active_knowledge: knowledge.filter((n) => n.status !== "deprecated").length,
    deprecated_knowledge: knowledge.filter((n) => n.status === "deprecated").length,
    total_nodes: nodes.length,
  };
}

function initiativeSummary(state) {
  const by = {};
  for (const node of Object.values(state.nodes || {})) {
    if (!node.initiative) continue;
    by[node.initiative] = by[node.initiative] || { initiative: node.initiative, total: 0, done: 0, in_progress: 0 };
    by[node.initiative].total += 1;
    if (node.status === "done" || node.status === "resolved") by[node.initiative].done += 1;
    if (node.status === "in_progress") by[node.initiative].in_progress += 1;
  }
  return Object.values(by).sort((a, b) => b.total - a.total);
}

function recentActivity(state, limit = 20) {
  const log = state.log || [];
  const entries = log.slice(-limit).reverse();
  return entries.map((e) => {
    const node = state.nodes[e.node] || state.nodes[e.task];
    return { ...e, node_title: node ? node.title : null };
  });
}

function refsOf(node) {
  const seen = new Set();
  const out = [];
  const add = (ref) => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };
  for (const ref of node.refs || []) add(ref);
  const text = [node.body, node.definition, node.acceptance, ...(node.notes || []).map((n) => n.text)].join("\n");
  const re = /(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g;
  for (const m of text.matchAll(re)) add(m[0]);
  return out;
}

// --- server ----------------------------------------------------------------

export async function start({ projectDir, port = DEFAULT_PORT, log = console.error }) {
  // Fail fast at boot on a corrupt state, like before. After that, every
  // request re-reads the live state file so the UI tracks CLI mutations in
  // real time: no server restart and no browser reload required.
  let lastGood = await readState(projectDir).catch((err) => {
    // Corrupt state: surface it clearly instead of serving an empty board.
    throw new Error(`ui: cannot read state for ${projectDir}: ${err.message}`);
  });

  // Fresh read per request. If the file becomes unreadable mid-run, fall
  // back to the last good state and surface a visible alert instead of
  // killing the UI (the snapshot carries the state-read-error alert).
  async function freshState() {
    try {
      lastGood = await readState(projectDir);
      return { state: lastGood, read_error: null };
    } catch (err) {
      return { state: lastGood, read_error: err };
    }
  }

  function stateReadAlerts(readError) {
    return readError
      ? [{ kind: "state-read-error", code: readError.code || "STATE_READ_ERROR", message: readError.message }]
      : [];
  }

  const app = express();
  app.use(express.json());

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.get("/api/snapshot", async (req, res) => {
    const { state, read_error } = await freshState();
    if (!state) {
      return res.json({
        project: { root: projectDir, state_file: stateFile(projectDir), initialized: false },
        generated_at: new Date().toISOString(),
        initiatives: {},
        nodes: {},
        edges: [],
        derived: { ready: [], blocked: [], backlog: [], openGates: [] },
        summary: null,
        alerts: stateReadAlerts(read_error),
        recent_activity: [],
      });
    }
    const derived = deriveV2(state);
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
        project_id: state.project_id || null,
      },
      generated_at: new Date().toISOString(),
      initiatives: state.initiatives || {},
      nodes: state.nodes || {},
      edges: state.edges || [],
      derived,
      last_activity: lastActivity,
      summary: summaryOf(state, derived),
      alerts: [...stateReadAlerts(read_error), ...detectStaleClaims(state).map((s) => ({ kind: "stale-claim", ...s }))],
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
    const history = logForNode(state, id).slice(-50);
    res.json({
      node,
      blocking,
      dependents,
      informing,
      knowledge,
      history,
      refs: refsOf(node),
      derived_status: node.kind === "resolvable" ? deriveStatusFor(state, id) : node.status,
      is_current: isCurrent(state, id),
      superseded_by: supersededBy(state, id),
    });
  });

  app.get("/api/activity", async (req, res) => {
    const { state } = await freshState();
    if (!state) return res.json({ entries: [], total: 0, limit: 50, offset: 0 });
    const { action, agent, node, limit = 50, offset = 0 } = req.query;
    let entries = state.log || [];
    if (action) entries = entries.filter((e) => e.action === action);
    if (agent) entries = entries.filter((e) => e.agent === agent);
    if (node) entries = entries.filter((e) => e.node === node || e.task === node);
    const total = entries.length;
    const page = entries
      .slice(-parseInt(limit, 10) - parseInt(offset, 10), total - parseInt(offset, 10))
      .map((e) => {
        const n = state.nodes[e.node] || state.nodes[e.task];
        return { ...e, node_title: n ? n.title : null };
      })
      .reverse();
    res.json({ entries: page, total, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
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

function deriveStatusFor(state, id) {
  // A node is ready when it has no unsatisfied blockers; otherwise blocked.
  const node = state.nodes[id];
  const status = node.status || "open";
  if (status !== "open") return status;
  if (node.backlog === true) return "backlog";
  const blocking = blockingForNode(state, id);
  return blocking.every((b) => b.satisfied) ? "ready" : "blocked";
}

async function exists(p) {
  try {
    await import("node:fs/promises").then((fs) => fs.access(p));
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
