// ui/src/views/graph-view-model.mjs
//
// Pure selectors for Graph 2.0 view state (ADR-001).
//
// Implements the "modelo puro" pieza of the plan in
// .adrs/001-graph-view-model.md §Pipeline de selección:
//   snapshot → visibleSetForMode → applyGraphFilters → applyGraphSearch →
//   (layout) → focus (solo resaltado/atenuación; nunca filtra)
//
// Contract:
//   - No I/O. No DOM. No Solid signals. No knowledge of the renderer.
//   - Pure functions over literal inputs so a fixture (Node script or
//     future unit test) can exercise them without spinning up the UI.
//   - filterGraph in graph-helpers.mjs is left untouched; the new
//     selectors coexist and the renderer adopts them gradually. They are
//     not drop-in replacements — the new pipeline separates mode (base
//     set) from filters (intersection) from search.
//
// Exports:
//   - CLOSED_STATUSES, isClosed(status)
//   - visibleSetForMode(nodes, edges, mode)
//   - applyGraphFilters(visibleSet, filters)
//   - applyGraphSearch(visibleSet, query)
//   - upstreamBlockers(edges, id)
//   - downstreamImpact(edges, id)
//   - crossInitiativeEdges(nodes, edges)
//   - isExecutionEmpty(nodes, edges)
//   - normalizeGraphView(view)  — pure shape validation, used by the
//                                 store on write

// Statuses hidden in Execution per ADR-001 §Modos y conjuntos base:
// done | canceled | resolved | superseded | deprecated.
// Same set as filterGraph so the two pipelines agree on what "closed"
// means; the new pipeline keeps Execution "el conjunto operacional
// existente" (tasks/gates con status no terminal) and lets filters open
// it back up explicitly.
export const CLOSED_STATUSES = new Set([
  "done",
  "canceled",
  "resolved",
  "superseded",
  "deprecated",
]);

// Recognised graph view modes. "all" is auditoría avanzada y explícita
// (ADR-001 §Modos y conjuntos base).
export const GRAPH_VIEW_MODES = ["execution", "history", "all"];

// Recognised focus kinds. Per ADR-001 §Estado y ciclo de vida, el foco
// siempre tiene como objetivo el nodo seleccionado; nunca acumula.
export const GRAPH_VIEW_FOCUS_KINDS = ["upstream", "downstream", "initiative"];

export function isClosed(status) {
  return CLOSED_STATUSES.has(status || "open");
}

// Decide whether a node is "operational" for Execution mode: a resolvable
// (task or gate) whose persisted status is not in CLOSED_STATUSES.
// Knowledge is operational only when it has a visible relationship with
// the operational set (the visibleSetForMode pass wires that condition).
function isOperational(node) {
  if (!node) return false;
  if (node.kind === "knowledge") return false; // handled separately
  return !isClosed(node.status);
}

// Build a { nodes, edges } visible set for a given mode. Edges are
// pruned to endpoints present in `nodes` and (for execution/history) to
// the edge types the mode cares about.
//
// Modes:
//   - "execution": operational resolvables + their BLOCKS edges +
//                  knowledge incident to that set (one BLOCKS away or
//                  sharing a BLOCKS edge with another operational node).
//                  A knowledge node with no edge to the operational set
//                  is dropped.
//   - "history":   endpoints of DERIVED_FROM / SUPERSEDES (the existing
//                  historyChainIds helper), plus those edge types only.
//                  A non-chain node is dropped even if it has BLOCKS.
//   - "all":       everything the snapshot exposes, every edge type.
//                  Auditoría avanzada.
//
// The function is defensive against cycles and unknown edge endpoints:
// unknown ids are silently dropped, and the BFS below uses visited.
export function visibleSetForMode(nodes, edges, mode) {
  const safeNodes = nodes || {};
  const safeEdges = edges || [];
  if (mode === "all") {
    return { nodes: { ...safeNodes }, edges: safeEdges.slice() };
  }
  if (mode === "history") {
    const chain = historyChainIdsLocal(safeNodes, safeEdges);
    const outNodes = {};
    for (const id of chain) if (safeNodes[id]) outNodes[id] = safeNodes[id];
    const outEdges = safeEdges.filter(
      (e) =>
        (e.type === "DERIVED_FROM" || e.type === "SUPERSEDES") &&
        outNodes[e.from] &&
        outNodes[e.to],
    );
    return { nodes: outNodes, edges: outEdges };
  }
  // "execution" (default + ADR-mandated base).
  const operational = new Set();
  for (const [id, n] of Object.entries(safeNodes)) {
    if (isOperational(n)) operational.add(id);
  }
  // Edges that belong to the operational view: BLOCKS edges between two
  // operational nodes (cross-initiative edges are kept; the renderer
  // tags them visually via crossInitiativeEdges below).
  const blocksEdges = safeEdges.filter(
    (e) => e.type === "BLOCKS" && operational.has(e.from) && operational.has(e.to),
  );
  // Knowledge is included only if it has a BLOCKS relationship with an
  // operational node (incident in the BLOCKS sense — incident to the
  // operational subgraph on either side of a BLOCKS edge).
  const knowledgeIncident = new Set();
  for (const e of safeEdges) {
    if (e.type !== "BLOCKS") continue;
    if (operational.has(e.from) && safeNodes[e.to]?.kind === "knowledge") {
      knowledgeIncident.add(e.to);
    }
    if (operational.has(e.to) && safeNodes[e.from]?.kind === "knowledge") {
      knowledgeIncident.add(e.from);
    }
  }
  const outNodes = {};
  for (const id of operational) outNodes[id] = safeNodes[id];
  for (const id of knowledgeIncident) outNodes[id] = safeNodes[id];
  return { nodes: outNodes, edges: blocksEdges };
}

// Local copy of the history-chain computation that mirrors
// graph-helpers.mjs:historyChainIds — duplicated here so this module
// stands alone and a fixture script can import it without pulling in the
// whole renderer surface. The two implementations are intentionally
// equivalent; if they ever diverge, the divergence is a bug.
function historyChainIdsLocal(nodes, edges) {
  const ids = new Set();
  for (const e of edges || []) {
    if (e.type !== "DERIVED_FROM" && e.type !== "SUPERSEDES") continue;
    if (nodes[e.from]) ids.add(e.from);
    if (nodes[e.to]) ids.add(e.to);
  }
  return ids;
}

// Intersection filter over an already-computed visible set. Each filter
// is optional; the empty/all-empty case is a no-op. Edges are pruned to
// endpoints that survive the filter.
//
// Filters:
//   - initiative:  exact match against node.initiative
//   - kind:        dashboard kind (task / gate / knowledge) via kindFor
//   - status:      explicit persisted status; when set, it overrides the
//                  closed-status default hiding for the duration of the
//                  filter (mirrors filterGraph semantics so the two
//                  pipelines feel equivalent from the user's POV).
//
// kindFor is parameterised so this module does not need to import from
// graph-helpers.mjs (the helper file is the renderer's, not the model's;
// keeping the model self-contained makes fixtures trivial).
export function applyGraphFilters(visibleSet, filters, kindFor) {
  const resolveKind = kindFor || defaultKindFor;
  const { nodes: inNodes, edges: inEdges } = visibleSet || {
    nodes: {},
    edges: [],
  };
  const f = filters || {};
  const ini = f.initiative || "";
  const kind = f.kind || "";
  const status = f.status || "";
  const outNodes = {};
  for (const [id, n] of Object.entries(inNodes)) {
    if (ini && n.initiative !== ini) continue;
    if (kind && resolveKind(n) !== kind) continue;
    if (status) {
      if ((n.status || "open") !== status) continue;
    }
    outNodes[id] = n;
  }
  const outEdges = (inEdges || []).filter(
    (e) => outNodes[e.from] && outNodes[e.to],
  );
  return { nodes: outNodes, edges: outEdges };
}

// Search by id/title, case-insensitive. Empty/whitespace query is a
// no-op. Mirrors graph-helpers.mjs:nodeMatchesQuery without re-exporting
// it; the model owns its own predicate so renames / changes here do not
// affect the renderer.
export function applyGraphSearch(visibleSet, query) {
  const { nodes: inNodes, edges: inEdges } = visibleSet || {
    nodes: {},
    edges: [],
  };
  const q = (query || "").trim().toLowerCase();
  if (!q) return { nodes: { ...inNodes }, edges: (inEdges || []).slice() };
  const outNodes = {};
  for (const [id, n] of Object.entries(inNodes)) {
    const idLc = (id || "").toLowerCase();
    const titleLc = (n.title || "").toLowerCase();
    if (idLc.includes(q) || titleLc.includes(q)) outNodes[id] = n;
  }
  const outEdges = (inEdges || []).filter(
    (e) => outNodes[e.from] && outNodes[e.to],
  );
  return { nodes: outNodes, edges: outEdges };
}

// BFS over BLOCKS edges in the upstream direction: starting from `id`,
// walk every BLOCKS edge where `to === current`, then recurse from
// `from`. Cycle-safe (visited set). Returns the set of ids reachable
// upstream, EXCLUDING the seed `id` — the renderer adds the seed back
// separately when it wants the full focus set.
//
// ADR-001: "sin prometer una critical path inexistente" — we never
// collapse multiple paths into one, we just collect reachability.
export function upstreamBlockers(edges, id) {
  return bfsBlocks(edges, id, "upstream");
}

// Mirror of upstreamBlockers in the other direction.
export function downstreamImpact(edges, id) {
  return bfsBlocks(edges, id, "downstream");
}

function bfsBlocks(edges, id, direction) {
  const out = new Set();
  if (!id) return out;
  // Adjacency maps keyed by direction. Keeping them local per call is
  // fine for the sizes Graph 2.0 targets (hundreds, not thousands).
  const incoming = new Map(); // to -> [{from}]
  const outgoing = new Map(); // from -> [{to}]
  for (const e of edges || []) {
    if (e.type !== "BLOCKS") continue;
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    incoming.get(e.to).push(e.from);
    outgoing.get(e.from).push(e.to);
  }
  const queue = [id];
  const visited = new Set([id]); // seed: do not include `id` itself
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbours =
      direction === "upstream" ? incoming.get(current) : outgoing.get(current);
    if (!neighbours) continue;
    for (const next of neighbours) {
      if (visited.has(next)) continue;
      visited.add(next);
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

// Edges whose endpoints live in different initiatives. Pure derived
// selector: input nodes/edges only, no schema changes (ADR-001
// §Relaciones y cruces entre initiatives).
//
// Endpoints whose node is missing from `nodes` are NOT cross-initiative
// (they are orphans); they are filtered out so the caller can trust the
// shape.
export function crossInitiativeEdges(nodes, edges) {
  const safeNodes = nodes || {};
  const out = [];
  for (const e of edges || []) {
    const a = safeNodes[e.from];
    const b = safeNodes[e.to];
    if (!a || !b) continue;
    if ((a.initiative || "") !== (b.initiative || "")) out.push(e);
  }
  return out;
}

// Convenience predicate for the "Execution vacío ofrece transición
// explícita a History" rule (ADR-001 §Modos y conjuntos base, Execution).
// Returns true when the operational set has zero nodes, regardless of
// any filters applied afterwards (this is the mode-level signal; a
// filter that hides everything is a user choice and is handled by the
// renderer separately).
export function isExecutionEmpty(nodes, edges) {
  const { nodes: visible } = visibleSetForMode(nodes, edges, "execution");
  return Object.keys(visible).length === 0;
}

// Validate + normalise a candidate graphView object. Pure: no I/O, no
// signals. Returns the canonical { mode, focus } shape; throws on
// invalid input so the store can wrap it as a structured error.
//
// Rules:
//   - mode: must be one of GRAPH_VIEW_MODES. Default "execution".
//   - focus: null OR { kind: one of GRAPH_VIEW_FOCUS_KINDS, id: string }.
//            Per ADR-001 §Estado y ciclo de vida the focus object is
//            never accumulated: a new focus replaces the previous one.
export function normalizeGraphView(view) {
  const v = view && typeof view === "object" ? view : {};
  const mode = GRAPH_VIEW_MODES.includes(v.mode) ? v.mode : "execution";
  let focus = null;
  if (v.focus && typeof v.focus === "object") {
    const kind = v.focus.kind;
    const id = typeof v.focus.id === "string" ? v.focus.id : null;
    if (GRAPH_VIEW_FOCUS_KINDS.includes(kind) && id) {
      focus = { kind, id };
    }
  }
  return { mode, focus };
}

// Default kind resolution so applyGraphFilters does not need a kindFor
// parameter in the common case. Mirrors graph-helpers.mjs:kindFor: a
// node is a knowledge when kind === "knowledge", a gate when subkind
// === "gate", a task otherwise. Kept private to the model.
function defaultKindFor(node) {
  if (!node) return "task";
  if (node.kind === "knowledge") return "knowledge";
  if (node.subkind === "gate") return "gate";
  return "task";
}

// Re-exported so callers that want the explicit shape contract don't
// have to duplicate it. Useful for consumers that build dropdowns.
export const GRAPH_VIEW_KINDS = {
  upstream: "upstream",
  downstream: "downstream",
  initiative: "initiative",
};
