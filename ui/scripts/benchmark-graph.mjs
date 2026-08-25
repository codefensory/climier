#!/usr/bin/env node
// ui/scripts/benchmark-graph.mjs — Graph layout baselines (T-ui-graph-benchmark,
// T-ui-graph-renderer-baseline).
//
// Reproducible headless benchmark that exercises the pure layout helpers
// used by ui/src/views/Graph.jsx over a 200-node fixture. See
// .adrs/002-graph-layout-and-performance.md §Presupuesto y evidencia.
//
// Why a Node script and not a browser run:
//   - The browser draws cytoscape/dagre on canvas; the actual layout
//     algorithm and element construction live in pure helpers that run
//     identically under Node. A headless Node run is reproducible, runs
//     without a server or browser, and avoids measurement noise from
//     the DOM/raf cycle.
//   - The graph-helpers are imported directly (the existing module is
//     pure ESM with no DOM deps) so we measure the same code path the
//     renderer calls before handing off to cytoscape.
//
// The script reports two clearly-labelled profiles (see result.metrics):
//   - helper_pure              — computeLayout + toCytoscapeElements, no DOM
//   - cytoscape_dagre_headless — cytoscape instance (headless: true) running
//                                cytoscape-dagre over the SAME helper-built
//                                elements; does NOT measure canvas paint,
//                                the DOM overlay, gestures or browser FPS
//
// Usage:
//   node scripts/benchmark-graph.mjs                # human-readable summary
//   node scripts/benchmark-graph.mjs --json        # single JSON object
//   RUNS=30 node scripts/benchmark-graph.mjs --json
//   FIXTURE=path/to/other.json node scripts/benchmark-graph.mjs --json
//
// Exit codes:
//   0  benchmark ran and the fixture satisfied every invariant
//   1  fixture invariant failed (clear error printed to stderr)
//   2  bad CLI usage (e.g. unknown flag without --help)

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";

import {
  computeLayout,
  toCytoscapeElements,
} from "../src/views/graph-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(HERE, "..", "fixtures", "graph-200.json");

// ---------- CLI parsing (positional + flags, no extra deps) -----------------

function parseArgs(argv) {
  const flags = new Set();
  const kv = {};
  for (const a of argv) {
    if (a === "--help" || a === "-h") flags.add("help");
    else if (a === "--json") flags.add("json");
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) flags.add(a.slice(2));
      else kv[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return { flags, kv };
}

const HELP = `Usage: node scripts/benchmark-graph.mjs [--json] [--fixture=PATH]

Options:
  --json         Emit a single JSON object to stdout (machine-readable).
                 Default: human-readable summary on stdout, JSON on stderr.
  --fixture=PATH Override the fixture path (default: ui/fixtures/graph-200.json).
  --help, -h     Print this help.

Env:
  RUNS=N         Number of timed iterations (default 20, must be >= 3).
  WARMUP=N       Warmup iterations excluded from samples (default 3).

Exit codes:
  0  success    1  fixture invariant failed    2  bad CLI usage
`;

const { flags, kv } = parseArgs(process.argv.slice(2));
if (flags.has("help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
const WANTS_JSON = flags.has("json");
const FIXTURE_PATH = kv.fixture || process.env.FIXTURE || DEFAULT_FIXTURE;

const RUNS = Math.max(3, parseInt(process.env.RUNS || "20", 10));
const WARMUP = Math.max(0, parseInt(process.env.WARMUP || "3", 10));

// ---------- Fixture loading --------------------------------------------------

let fixtureRaw;
try {
  fixtureRaw = readFileSync(FIXTURE_PATH, "utf8");
} catch (err) {
  process.stderr.write(`benchmark-graph: cannot read fixture ${FIXTURE_PATH}: ${err.message}\n`);
  process.exit(1);
}

let fixture;
try {
  fixture = JSON.parse(fixtureRaw);
} catch (err) {
  process.stderr.write(`benchmark-graph: fixture ${FIXTURE_PATH} is not valid JSON: ${err.message}\n`);
  process.exit(1);
}

// ---------- Fixture invariants (hard failures) -------------------------------

const invariants = [];
function failInvariant(code, message, details) {
  invariants.push({ ok: false, code, message, details });
}
function passInvariant(code) {
  invariants.push({ ok: true, code });
}

const nodes = fixture.nodes || {};
const edges = Array.isArray(fixture.edges) ? fixture.edges : [];
const initiatives = Object.keys(fixture.initiatives || {});

const nodeCount = Object.keys(nodes).length;
if (nodeCount === 200) passInvariant("node_count");
else failInvariant("node_count", `expected exactly 200 nodes, found ${nodeCount}`, { count: nodeCount });

if (initiatives.length >= 5) passInvariant("initiatives_min_5");
else failInvariant("initiatives_min_5", `expected >=5 initiatives, found ${initiatives.length}`, { count: initiatives.length });

let tasks = 0;
let gates = 0;
let knowledge = 0;
for (const n of Object.values(nodes)) {
  if (!n) continue;
  if (n.kind === "knowledge") knowledge += 1;
  else if (n.subkind === "gate") gates += 1;
  else tasks += 1;
}
if (tasks > 0 && gates > 0 && knowledge > 0) {
  passInvariant("kinds_mixed");
} else {
  failInvariant("kinds_mixed", `expected task, gate and knowledge nodes; got tasks=${tasks} gates=${gates} knowledge=${knowledge}`);
}

// Missing endpoints: every edge.from / edge.to must be a known node.
let missingFrom = 0;
let missingTo = 0;
for (const e of edges) {
  if (!e || typeof e.from !== "string" || typeof e.to !== "string") {
    failInvariant("edge_shape", `edge is missing from/to: ${JSON.stringify(e)}`);
    continue;
  }
  if (!nodes[e.from]) missingFrom += 1;
  if (!nodes[e.to]) missingTo += 1;
}
if (missingFrom === 0 && missingTo === 0) passInvariant("edge_endpoints_present");
else failInvariant("edge_endpoints_present", `${missingFrom} edges with unknown 'from', ${missingTo} edges with unknown 'to'`);

// BLOCKS acyclic check (cycle members keep BLOCKS depth=1, but the fixture
// contract forbids cycles so the layout uses real depth).
{
  const adj = new Map();
  for (const id of Object.keys(nodes)) adj.set(id, []);
  for (const e of edges) {
    if (e.type !== "BLOCKS") continue;
    if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of adj.keys()) color.set(id, WHITE);
  let hasCycle = false;
  const stack = [];
  function visit(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) {
        const cycle = stack.slice(stack.indexOf(v)).concat(v);
        failInvariant("blocks_acyclic", `BLOCKS edge set has a cycle: ${cycle.join(" -> ")}`, { cycle });
        hasCycle = true;
        return;
      }
      if (color.get(v) === WHITE) {
        visit(v);
        if (hasCycle) return;
      }
    }
    color.set(u, BLACK);
    stack.pop();
  }
  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      visit(id);
      if (hasCycle) break;
    }
  }
  if (!hasCycle) passInvariant("blocks_acyclic");
}

// Cross-initiative BLOCKS: at least one BLOCKS edge where from and to
// belong to different initiatives (otherwise the fixture does not exercise
// the cross-initiative path the ADR baseline cares about).
{
  const cross = edges.filter(
    (e) =>
      e.type === "BLOCKS" &&
      nodes[e.from] &&
      nodes[e.to] &&
      nodes[e.from].initiative !== nodes[e.to].initiative,
  );
  if (cross.length > 0) passInvariant("cross_initiative_blocks");
  else failInvariant("cross_initiative_blocks", "expected at least one cross-initiative BLOCKS edge");
}

// SUPERSEDES and DERIVED_FROM endpoints present (history chain needs them).
{
  const types = new Set(edges.map((e) => e.type));
  if (types.has("SUPERSEDES")) passInvariant("supersedes_present");
  else failInvariant("supersedes_present", "expected at least one SUPERSEDES edge");
  if (types.has("DERIVED_FROM")) passInvariant("derived_from_present");
  else failInvariant("derived_from_present", "expected at least one DERIVED_FROM edge");
}

if (invariants.some((i) => !i.ok)) {
  const failed = invariants.filter((i) => !i.ok);
  process.stderr.write("benchmark-graph: fixture failed invariants:\n");
  for (const f of failed) {
    process.stderr.write(`  - [${f.code}] ${f.message}\n`);
    if (f.details) process.stderr.write(`      ${JSON.stringify(f.details)}\n`);
  }
  process.exit(1);
}

// ---------- Timed runs -------------------------------------------------------
//
// Two profiles, both over the same fixture/elements. Each profile runs its
// own warmup + RUNS and is summarised independently so the JSON output can
// distinguish the two unambiguously.
//
//   1) helper_pure
//        computeLayout + toCytoscapeElements executed in plain Node. This is
//        the pure-compute budget that the renderer spends before handing off
//        to cytoscape. No DOM, no canvas, no cytoscape instance.
//
//   2) cytoscape_dagre_headless
//        A fresh cytoscape({ headless: true, styleEnabled: false }) instance
//        with cytoscape-dagre registered, fed the SAME elements produced by
//        toCytoscapeElements(). The timed slice is just the synchronous
//        layout.run() call (animate: false). This isolates the dagre
//        algorithm cost over the helper-built elements. The instance is
//        destroyed after each iteration so cached layout state cannot bleed
//        across samples.
//        This profile does NOT measure canvas paint, the DOM overlay of
//        focus buttons, pan/zoom gestures, wheel latency or browser FPS.
//        Anything tied to a real <canvas> or the browser must be measured
//        separately (out of scope for this script by design).

const buildSamples = [];
const layoutSamples = [];
const cytoDagreSamples = [];

for (let i = 0; i < WARMUP; i++) {
  toCytoscapeElements(nodes, edges);
  computeLayout(nodes, edges);
  const cy = cytoscape({ headless: true, styleEnabled: false });
  cytoscape.use(dagre);
  cy.add(toCytoscapeElements(nodes, edges).elements);
  cy.layout({ name: "dagre", rankDir: "LR", fit: false, animate: false }).run();
  cy.destroy();
}

// helper_pure profile --------------------------------------------------------

for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const { elements } = toCytoscapeElements(nodes, edges);
  const t1 = performance.now();
  const layout = computeLayout(nodes, edges);
  const t2 = performance.now();
  if (i === 0 && (elements.length === 0 || Object.keys(layout.pos).length === 0)) {
    process.stderr.write("benchmark-graph: helper produced empty output (sanity failure)\n");
    process.exit(1);
  }
  buildSamples.push(t1 - t0);
  layoutSamples.push(t2 - t1);
}

// cytoscape_dagre_headless profile -------------------------------------------
//
// Build the elements once outside the timed loop (the construction cost is
// already covered by helper_pure.build_elements_ms). Each timed iteration
// spins up a fresh cytoscape instance, registers dagre, adds the elements,
// runs the dagre layout and destroys the instance. Only the synchronous
// .run() call sits inside the timed window so the sample reflects dagre's
// algorithm cost, not cytoscape bootstrap.

const cytoElements = toCytoscapeElements(nodes, edges).elements;

for (let i = 0; i < RUNS; i++) {
  const cy = cytoscape({ headless: true, styleEnabled: false });
  cytoscape.use(dagre);
  cy.add(cytoElements);
  const t0 = performance.now();
  cy.layout({ name: "dagre", rankDir: "LR", fit: false, animate: false }).run();
  const t1 = performance.now();
  if (i === 0 && cy.nodes().length !== Object.keys(nodes).length) {
    process.stderr.write(
      `benchmark-graph: cytoscape headless dropped nodes (got ${cy.nodes().length}, expected ${Object.keys(nodes).length})\n`,
    );
    process.exit(1);
  }
  cytoDagreSamples.push(t1 - t0);
  cy.destroy();
}

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summary(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min,
    max,
    mean,
    samples: sorted,
  };
}

const cpus = os.cpus() || [];
const cytoscapeVersion = (cytoscape && cytoscape.version) || null;
// cytoscape-dagre exposes its package.json via require.resolve; resolve the
// installed copy so we surface the actual version that ran the layout.
const require = createRequire(import.meta.url);
let cytoscapeDagreVersion = null;
try {
  const pkgPath = require.resolve("cytoscape-dagre/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  cytoscapeDagreVersion = pkg.version || null;
} catch (err) {
  cytoscapeDagreVersion = null;
}

const result = {
  ok: true,
  fixture: {
    path: path.relative(process.cwd(), FIXTURE_PATH) || FIXTURE_PATH,
    version: fixture.version || null,
    seed: typeof fixture.seed === "number" ? fixture.seed : null,
    nodes: nodeCount,
    edges: edges.length,
    initiatives: initiatives.length,
    kinds: { tasks, gates, knowledge },
    edge_types: edges.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {}),
  },
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu_model: cpus[0] ? cpus[0].model : null,
    cpus: cpus.length,
    headless: true,
    json_output: WANTS_JSON,
    cytoscape_version: cytoscapeVersion,
    cytoscape_dagre_version: cytoscapeDagreVersion,
  },
  iterations: {
    warmup: WARMUP,
    runs: RUNS,
  },
  metrics: {
    helper_pure: {
      description:
        "Pure ESM helpers (computeLayout + toCytoscapeElements) executed in plain Node over the fixture; no DOM, no cytoscape instance.",
      renderer: "graph-helpers (computeLayout + toCytoscapeElements)",
      rendering_target: "none — pure compute, no canvas, no DOM",
      build_elements_ms: summary(buildSamples),
      layout_ms: summary(layoutSamples),
    },
    cytoscape_dagre_headless: {
      description:
        "Fresh cytoscape({ headless: true, styleEnabled: false }) instance with cytoscape-dagre registered, fed the same elements produced by toCytoscapeElements(). Timed slice is the synchronous layout.run() call (animate: false).",
      renderer: `cytoscape@${cytoscapeVersion || "?"} + cytoscape-dagre@${cytoscapeDagreVersion || "?"} (headless)`,
      rendering_target:
        "none — headless mode without DOM/canvas/window; does NOT measure browser canvas paint, the focus-overlay buttons, pan/zoom gestures, wheel latency or FPS",
      layout_options: {
        name: "dagre",
        rankDir: "LR",
        fit: false,
        animate: false,
      },
      instances_per_sample: 1,
      layout_ms: summary(cytoDagreSamples),
    },
  },
};

if (WANTS_JSON) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  const f = (n) => `${n.toFixed(3)} ms`;
  const hp = result.metrics.helper_pure;
  const cd = result.metrics.cytoscape_dagre_headless;
  process.stdout.write(
    [
      `fixture: ${result.fixture.path}`,
      `nodes=${result.fixture.nodes} edges=${result.fixture.edges} initiatives=${result.fixture.initiatives}`,
      `kinds: ${JSON.stringify(result.fixture.kinds)}`,
      `runtime: node ${result.runtime.node} ${result.runtime.platform}/${result.runtime.arch} (${result.runtime.cpus} CPUs) cytoscape@${result.runtime.cytoscape_version} cytoscape-dagre@${result.runtime.cytoscape_dagre_version}`,
      `runs: warmup=${WARMUP} timed=${RUNS}`,
      `helper_pure.build_elements_ms:        p50=${f(hp.build_elements_ms.p50)} p95=${f(hp.build_elements_ms.p95)} mean=${f(hp.build_elements_ms.mean)}`,
      `helper_pure.layout_ms:                p50=${f(hp.layout_ms.p50)} p95=${f(hp.layout_ms.p95)} mean=${f(hp.layout_ms.mean)}`,
      `cytoscape_dagre_headless.layout_ms:   p50=${f(cd.layout_ms.p50)} p95=${f(cd.layout_ms.p95)} mean=${f(cd.layout_ms.mean)}`,
      ``,
      `(headless profile does NOT measure canvas, overlay or browser FPS)`,
      `(use --json for the full machine-readable result)`,
      ``,
    ].join("\n"),
  );
}