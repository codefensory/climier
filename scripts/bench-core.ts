#!/usr/bin/env bun
// Core profile harness.
//
//   bun scripts/bench-core.ts                          # sintetico por defecto (594 nodos)
//   bun scripts/bench-core.ts --fixture <tasks.json>    # corpus real propio
//   bun scripts/bench-core.ts --iterations 9
//   bun scripts/bench-core.ts --sweep 600,2000,5000,10000   # escala sintetica
//   bun scripts/bench-core.ts --synth 20000 --json
//
// Builds a throwaway CLIMIER_HOME, migrates the corpus to SQLite, then measures
// end-to-end (process) and in-process (layers) on the same copy. The default is
// synthetic so the ADR measurements reproduce on any machine.

/* oxlint-disable complexity, max-lines, max-lines-per-function, max-statements -- linear measurement sequence: one readable pass per recorded stage keeps a report reproducible. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSqliteState, readSqliteChangesSince, writeSqliteState, updateSqliteState } from "../src/storage/sqlite/store.ts";
import { validateStateInvariants } from "../src/contracts/state-invariants.ts";
import { createTransaction } from "../src/kernel/transaction.ts";
import { projectStatusView, projectContextView } from "../src/read-model/index.ts";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.ts";
import { executeOperation } from "../src/application/operations/execute.ts";
import { mutate } from "../src/kernel/mutate.ts";
import { newlyReadyTasks } from "../src/providers/task/derivation.ts";
import { runCliInProcess } from "../test/cli-harness.ts";
import type { ProjectState } from "../src/contracts/domain.ts";
import type { ReadModelSnapshot } from "../src/read-model/types.ts";

const options = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const raw = argv[i];
  if (!raw.startsWith("--")) { continue; }
  const [key, inline] = raw.slice(2).split("=");
  if (inline !== undefined) { options.set(key, inline); continue; }
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) { options.set(key, next); i += 1; continue; }
  options.set(key, "true");
}

const projectRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(projectRoot, "bin", "climier.ts");
const dispatchUrl = new URL("../src/cli/dispatch.ts", import.meta.url).href;
// Node count of the corpus the ADRs measured; keeps the zero-argument run reproducible.
const DEFAULT_SYNTH_NODES = 594;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function syntheticState(nodeCount: number, { bodyBytes = 1200, logPerNode = 8, extraEdges = 0.5 } = {}) {
  const random = prng(nodeCount);
  const now = new Date().toISOString();
  const ids: string[] = [];
  const nodes: Record<string, unknown> = {};
  for (let i = 0; i < nodeCount; i += 1) {
    const id = `T-syn-${i}`;
    ids.push(id);
    nodes[id] = {
      id, kind: "resolvable", subkind: "task",
      title: `Synthetic task ${i}`,
      body: `Cuerpo sintetico ${i}. `.repeat(Math.ceil(bodyBytes / 20)).slice(0, bodyBytes),
      acceptance: "Aceptacion sintetica verificable.",
      status: i % 11 === 0 ? "in_progress" : "open",
      initiative: "bench", created_at: now, updated_at: now, revision: i + 1,
    };
  }
  const edges: Array<{ from: string; to: string; type: string }> = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, type: string) => {
    if (from === to) { return; }
    const key = `${from}|${to}|${type}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    edges.push({ from, to, type });
  };
  for (let i = 1; i < nodeCount; i += 1) { addEdge(ids[i - 1], ids[i], "BLOCKS"); }
  const extra = Math.floor(nodeCount * extraEdges);
  for (let i = 0; i < extra * 2 && edges.length < nodeCount + extra; i += 1) {
    addEdge(ids[Math.floor(random() * nodeCount)], ids[Math.floor(random() * nodeCount)], "DERIVED_FROM");
  }
  const log: Array<Record<string, unknown>> = [];
  for (let i = 0; i < nodeCount * logPerNode; i += 1) {
    log.push({ ts: now, agent: "bench", action: i % 3 === 0 ? "note.add" : "task.update", node: ids[i % nodeCount], revision: i + 1 });
  }
  return {
    state: { version: 1, revision: log.length, initiatives: { bench: { desc: "synthetic corpus", created_at: now } }, nodes, edges, log },
    counts: { nodes: nodeCount, edges: edges.length, log: log.length },
  };
}

type Fixture = { label: string; file: string; counts: { nodes: number; edges: number; log: number } };

function makeWorkspace(fixture: Fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "climier-bench-"));
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const projectId = `bench${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const stateDir = path.join(home, "projects", projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
  fs.copyFileSync(fixture.file, path.join(stateDir, "tasks.json"));
  const env = { ...process.env, CLIMIER_HOME: home, CLIMIER_STATE_BACKEND: "" };
  const run = (args: string[]) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, [cli, "--project", projectDir, ...args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
    });
    return { ms: performance.now() - started, ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
  };
  const migrate = run(["state", "migrate", "--yes", "--as", "bench"]);
  if (!migrate.ok) { throw new Error(`migration failed: ${migrate.out.slice(0, 600)}`); }
  const sqliteFile = path.join(stateDir, "state.sqlite");
  if (!fs.existsSync(sqliteFile)) { throw new Error("migration produced no state.sqlite"); }
  return { root, home, projectDir, sqliteFile, env, run };
}

async function timeAsync(fn: () => unknown, runs: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

async function timeResettableAsync(fn: () => Promise<unknown>, reset: () => Promise<void>, runs: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    await reset();
    (globalThis as unknown as { Bun?: { gc(force?: boolean): void } }).Bun?.gc(true);
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

function timeSync(fn: () => unknown, runs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

// Prototype of the target: build the BLOCKS adjacency once and memoize
// satisfaction, so readiness for every node is O(N + E) instead of O(N * E).
function readinessPrototype(snapshot: ProjectState) {
  const incoming = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.type !== "BLOCKS") { continue; }
    const bucket = incoming.get(edge.to);
    if (bucket) { bucket.push(edge.from); } else { incoming.set(edge.to, [edge.from]); }
  }
  const satisfied = new Map<string, boolean>();
  const SATISFIED = new Set(["done", "archived"]);
  const satisfy = (id: string, seen: Set<string>): boolean => {
    const cached = satisfied.get(id);
    if (cached !== undefined) { return cached; }
    const node = snapshot.nodes[id];
    let result = false;
    if (node && node.kind !== "knowledge" && !seen.has(id)) {
      if (node.subkind === "gate") {
        const status = node.status || "open";
        result = status === "resolved" || status === "superseded";
      } else if (node.subkind === "task") {
        result = SATISFIED.has(node.status || "open");
      }
    }
    satisfied.set(id, result);
    return result;
  };
  let ready = 0;
  let blocked = 0;
  for (const [id, node] of Object.entries(snapshot.nodes)) {
    if (!node || node.subkind !== "task") { continue; }
    const status = node.status || "open";
    if (status !== "open" || node.backlog === true) { continue; }
    const blockers = incoming.get(id) ?? [];
    let ok = true;
    for (const blocker of blockers) {
      if (!satisfy(blocker, new Set())) { ok = false; break; }
    }
    if (ok) { ready += 1; } else { blocked += 1; }
  }
  return { ready, blocked };
}

async function measure(fixture: Fixture, iterations: number) {
  const workspace = makeWorkspace(fixture);
  const snapshot = await readSqliteState(workspace.sqliteFile) as ProjectState;
  const registry = createBuiltinOperationRegistry();
  // The probe must be a task: gates and knowledge reject task.update/add-note preconditions.
  const probeId = Object.values(snapshot.nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task")
    .map((node) => node.id)[0] ?? Object.keys(snapshot.nodes)[0];
  const acceptState = structuredClone(snapshot);
  const acceptTarget = Object.values(acceptState.nodes).find((node) =>
    node.kind === "resolvable" && node.subkind === "task",
  );
  if (!acceptTarget) { throw new Error(`no task available to benchmark accept in ${fixture.label}`); }
  const acceptTargetId = acceptTarget.id;
  Object.assign(acceptTarget, {
    status: "submitted",
    submitted_by: "bench",
    submitted_at: new Date().toISOString(),
    claim: null,
  });
  const acceptedState = structuredClone(acceptState);
  acceptedState.nodes[acceptTargetId].status = "done";
  const acceptFixtureFile = path.join(workspace.root, "accept-fixture.json");
  fs.writeFileSync(acceptFixtureFile, JSON.stringify(acceptState));
  const acceptWorkspace = makeWorkspace({ ...fixture, file: acceptFixtureFile });
  const resetAcceptDatabase = () => writeSqliteState(acceptWorkspace.sqliteFile, acceptState);
  const readModelSnapshot = snapshot as unknown as ReadModelSnapshot;
  const rawNodes = JSON.stringify(snapshot.nodes);
  const rawLog = JSON.stringify(snapshot.log);
  const copy = path.join(workspace.root, "write-probe.sqlite");
  fs.copyFileSync(workspace.sqliteFile, copy);
  const moduleGraph = Number(spawnSync(process.execPath, ["-e",
    `const t=performance.now(); await import(${JSON.stringify(dispatchUrl)}); console.log((performance.now()-t).toFixed(2))`,
  ], { env: workspace.env, encoding: "utf8" }).stdout.trim());

  const e2e: Record<string, number> = {};
  for (const [label, command] of [
    ["version", ["--version"]],
    ["status", ["status"]],
    ["context", ["context", probeId]],
    ["history", ["history", probeId, "--limit", "50"]],
    ["log", ["log", "--limit", "50"]],
    ["search", ["search", "Synthetic"]],
    ["show", ["show", probeId]],
    ["initiatives", ["initiatives"]],
  ] as Array<[string, string[]]>) {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) { samples.push(workspace.run(command).ms); }
    e2e[label] = median(samples);
  }
  const mutationSamples: number[] = [];
  let mutationOk = true;
  let mutationError = "";
  for (let i = 0; i < Math.max(2, Math.min(iterations, 5)); i += 1) {
    const result = workspace.run(["add-note", probeId, `bench ${i}`, "--as", "bench"]);
    mutationSamples.push(result.ms);
    if (!result.ok) { mutationOk = false; mutationError = result.out.slice(0, 200); }
  }
  e2e["add-note"] = median(mutationSamples);
  const acceptSamples: number[] = [];
  for (let i = 0; i < Math.max(3, Math.min(iterations, 5)); i += 1) {
    await resetAcceptDatabase();
    const result = acceptWorkspace.run(["accept", acceptTargetId, "--as", "bench"]);
    acceptSamples.push(result.ms);
    if (!result.ok) { throw new Error(`accept benchmark failed: ${result.out.slice(0, 300)}`); }
  }
  e2e.accept = median(acceptSamples);

  const layers: Record<string, number> = {
    "read (sin bodies)": await timeAsync(() => readSqliteState(workspace.sqliteFile, { includeBodies: false }), iterations),
    "read (con bodies)": await timeAsync(() => readSqliteState(workspace.sqliteFile), iterations),
    "changes since N": await timeAsync(() => readSqliteChangesSince(workspace.sqliteFile, Math.max(0, (snapshot.revision ?? 0) - 10)), iterations),
    "parse nodes": timeSync(() => JSON.parse(rawNodes), iterations),
    "parse log": timeSync(() => JSON.parse(rawLog), iterations),
    "validate invariants": timeSync(() => validateStateInvariants(snapshot, "bench"), iterations),
    "createTransaction": timeSync(() => createTransaction(snapshot), iterations),
    "structuredClone(state)": timeSync(() => structuredClone(snapshot), iterations),
    "status view": timeSync(() => projectStatusView({ snapshot: readModelSnapshot, filters: {}, now: Date.now() }), iterations),
    "accept readiness delta": timeSync(() => newlyReadyTasks(acceptState, acceptedState, acceptTargetId), iterations),
    "readiness prototype (adjacency)": timeSync(() => readinessPrototype(snapshot), iterations),
    "context view": timeSync(() => projectContextView({ snapshot: readModelSnapshot, id: probeId, agent: "bench", now: Date.now() }), iterations),
    "write replace total": await timeAsync(() => writeSqliteState(copy, snapshot, snapshot), 3),
    "update no-op": await timeAsync(() => updateSqliteState(copy, (state) => state), 3),
    "status in-process": await timeAsync(() => runCliInProcess(["status"], { cwd: workspace.projectDir, env: workspace.env }), iterations),
    "update in-process": await timeResettableAsync(async () => {
      const previousHome = process.env.CLIMIER_HOME;
      process.env.CLIMIER_HOME = workspace.home;
      try {
        await executeOperation({
          projectDir: workspace.projectDir,
          actor: "bench",
          operation: "task.update",
          input: {
            id: probeId,
            if_revision: snapshot.nodes[probeId].revision,
            changes: { title: `bench ${snapshot.nodes[probeId].title}` },
          },
          source: { registry, mutate },
        });
      } finally {
        if (previousHome === undefined) { delete process.env.CLIMIER_HOME; }
        else { process.env.CLIMIER_HOME = previousHome; }
      }
    }, () => writeSqliteState(workspace.sqliteFile, snapshot), Math.max(3, Math.min(iterations, 5))),
    "accept in-process": await timeResettableAsync(async () => {
      const result = await runCliInProcess(["accept", acceptTargetId, "--as", "bench"], { cwd: acceptWorkspace.projectDir, env: acceptWorkspace.env });
      if (result.code !== 0) { throw new Error(`accept in-process benchmark failed: ${result.stdout.slice(0, 300)}`); }
    }, resetAcceptDatabase, Math.max(3, Math.min(iterations, 5))),
    "add-note in-process": await timeAsync(() => runCliInProcess(["add-note", probeId, "ip", "--as", "bench"], { cwd: workspace.projectDir, env: workspace.env }), 3),
  };
  const report = {
    label: fixture.label,
    counts: fixture.counts,
    sqliteBytes: fs.statSync(workspace.sqliteFile).size,
    moduleGraphMs: moduleGraph,
    mutationOk,
    mutationError,
    e2e,
    layers,
  };
  fs.rmSync(acceptWorkspace.root, { recursive: true, force: true });
  fs.rmSync(workspace.root, { recursive: true, force: true });
  return report;
}

function printReport(report: Awaited<ReturnType<typeof measure>>) {
  const floor = report.e2e.version;
  if (!report.mutationOk) { console.log(`  !! add-note fallo: ${report.mutationError.replace(/\n/g, " ")}`); }
  console.log(`\n# ${report.label} — ${report.counts.nodes} nodos · ${report.counts.edges} edges · ${report.counts.log} log · sqlite ${(report.sqliteBytes / 1048576).toFixed(1)} MB · boot ${report.moduleGraphMs.toFixed(1)} ms`);
  console.log("E2E".padEnd(16), "ms".padStart(8), "− piso".padStart(9));
  for (const [label, ms] of Object.entries(report.e2e)) {
    console.log(label.padEnd(16), ms.toFixed(1).padStart(8), (ms - floor).toFixed(1).padStart(9));
  }
  console.log("capa".padEnd(24), "ms".padStart(8));
  for (const [label, ms] of Object.entries(report.layers).toSorted((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(label.padEnd(24), (ms as number).toFixed(2).padStart(8));
  }
}

type Report = Awaited<ReturnType<typeof measure>>;
type Row = { metric: string; values: number[]; ratio: number; verdict: string };

function verdict(ratio: number, sizeRatio: number): string {
  if (ratio > sizeRatio * 1.6) { return "SUPERLINEAL"; }
  if (ratio < sizeRatio * 0.5) { return "sublineal"; }
  return "lineal";
}

function scaleRow(label: string, reports: Report[], pick: (report: Report) => number, sizeRatio: number): Row {
  const values = reports.map(pick);
  const ratio = values.at(-1)! / Math.max(values[0], 0.05);
  return { metric: label, values, ratio, verdict: verdict(ratio, sizeRatio) };
}

function printSweep(reports: Report[]) {
  const first = reports[0];
  const last = reports.at(-1)!;
  const sizeRatio = last.counts.nodes / first.counts.nodes;
  console.log(`\nEscala: ${first.counts.nodes} -> ${last.counts.nodes} nodos (x${sizeRatio.toFixed(1)})`);
  const rows = [
    ...Object.keys(last.layers).map((label) => scaleRow(label, reports, (report) => (report.layers[label] ?? 0) as number, sizeRatio)),
    ...Object.keys(last.e2e)
      .filter((label) => label !== "version")
      .map((label) => scaleRow(`e2e ${label}`, reports, (report) => (report.e2e[label] ?? 0) as number, sizeRatio)),
  ].toSorted((a, b) => b.values.at(-1)! - a.values.at(-1)!);
  console.log("metrica".padEnd(24) + reports.map((report) => String(report.counts.nodes).padStart(9)).join("") + "   x  verdict");
  for (const row of rows) {
    console.log(
      row.metric.padEnd(24),
      row.values.map((value) => value.toFixed(1).padStart(9)).join(""),
      row.ratio.toFixed(1).padStart(5),
      `  ${row.verdict}`,
    );
  }
  for (const report of reports) { printReport(report); }
}

async function measureSweep(sizes: number[], runs: number): Promise<Report[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "climier-synth-"));
  const reports: Report[] = [];
  for (const size of sizes) {
    const { state, counts } = syntheticState(size);
    const file = path.join(root, `synth-${size}.json`);
    fs.writeFileSync(file, JSON.stringify(state));
    reports.push(await measure({ label: `synthetic ${size}`, file, counts }, runs));
  }
  fs.rmSync(root, { recursive: true, force: true });
  return reports;
}

function resolveFixture(synthOption: string | undefined): Fixture {
  const fixture = options.get("fixture");
  const synth = synthOption ?? (fixture ? undefined : String(DEFAULT_SYNTH_NODES));
  if (synth) {
    const size = Number(synth);
    const { state, counts } = syntheticState(size);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "climier-synth-")), `synth-${size}.json`);
    fs.writeFileSync(file, JSON.stringify(state));
    return { label: `synthetic ${size}`, file, counts };
  }
  const file = fixture;
  // "true" is the parser's sentinel for a flag given without a value.
  if (typeof file !== "string" || file === "true") {
    console.error("bench-core: --fixture requires a path to a canonical tasks.json");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`bench-core: fixture not found: ${file}`);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    label: path.basename(path.dirname(path.dirname(file))) || "fixture",
    file,
    counts: {
      nodes: Object.keys(parsed.nodes ?? {}).length,
      edges: parsed.edges?.length ?? 0,
      log: parsed.log?.length ?? 0,
    },
  };
}

const iterations = Number(options.get("iterations") ?? 5);
const json = options.get("json") === "true";
const sweep = options.get("sweep");

if (sweep) {
  const sizes = sweep.split(",").map((value) => Number(value.trim())).filter(Boolean).toSorted((a, b) => a - b);
  const reports = await measureSweep(sizes, Math.max(3, iterations));
  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    printSweep(reports);
  }
} else {
  const report = await measure(resolveFixture(options.get("synth")), iterations);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}
