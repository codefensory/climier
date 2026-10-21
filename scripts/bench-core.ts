#!/usr/bin/env bun
// Core profile harness: end-to-end per command + per-layer costs on the same
// fixture. Builds a throwaway CLIMIER_HOME so the caller's state is untouched.
//
//   bun scripts/bench-core.ts [--fixture <tasks.json>] [--iterations N] [--json] [--keep]
//
// The fixture is a schema-1 tasks.json; it is migrated to SQLite inside a temp
// home, then every measurement runs against that copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSqliteState, readSqliteChangesSince, writeSqliteState, updateSqliteState, withSqliteTransaction } from "../src/storage/sqlite/store.ts";
import { readState } from "../src/storage/state.ts";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.ts";
import { loadApplicablePolicy } from "../src/plugins/policy.ts";
import { runCliInProcess } from "../test/cli-harness.ts";
import { validateStateInvariants } from "../src/contracts/state-invariants.ts";
import { createTransaction } from "../src/kernel/transaction.ts";
import { projectStatusView, projectContextView } from "../src/read-model/index.ts";

const args = new Map<string, string>();
const flags = new Set<string>();
for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=");
  if (value === undefined) flags.add(key); else args.set(key, value);
}
const iterations = Number(args.get("iterations") ?? 7);
const fixtureArg = args.get("fixture");
const keep = flags.has("keep");
const asJson = flags.has("json");

const defaultFixture = path.join(os.homedir(), ".climier/projects/b4e2c579bbb81669/tasks.json");
const fixture = fixtureArg ?? defaultFixture;
if (!fs.existsSync(fixture)) {
  console.error(`bench-core: fixture not found: ${fixture} (pass --fixture <tasks.json>)`);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "climier-bench-"));
const home = path.join(root, "home");
const projectDir = path.join(root, "project");
const projectId = `bench${Date.now().toString(36)}`;
const stateDir = path.join(home, "projects", projectId);
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
fs.copyFileSync(fixture, path.join(stateDir, "tasks.json"));

const env = { ...process.env, CLIMIER_HOME: home, CLIMIER_STATE_BACKEND: "" };
const cli = path.join(import.meta.dir, "..", "bin", "climier.ts");

function run(argv: string[]): { ms: number; ok: boolean; out: string } {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, "--project", projectDir, ...argv], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  return { ms: performance.now() - started, ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

const migrated = run(["state", "migrate", "--yes", "--as", "bench"]);
if (!migrated.ok) {
  console.error(`bench-core: migration failed:\n${migrated.out.slice(0, 800)}`);
  process.exit(1);
}
const sqliteFile = path.join(stateDir, "state.sqlite");
if (!fs.existsSync(sqliteFile)) {
  console.error("bench-core: migration produced no state.sqlite");
  process.exit(1);
}

const snapshot = await readSqliteState(sqliteFile) as Record<string, any>;
const nodeIds = Object.keys(snapshot.nodes ?? {});
const probeId = nodeIds[0];
const counts = {
  nodes: nodeIds.length,
  edges: snapshot.edges?.length ?? 0,
  log: snapshot.log?.length ?? 0,
  initiatives: Object.keys(snapshot.initiatives ?? {}).length,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function timeAsync(fn: () => unknown, runs = iterations): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

function timeSync(fn: () => unknown, runs = iterations): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

// --- end to end (process + storage + command) -------------------------------
const commands: Array<[string, string[]]> = [
  ["--version (piso)", ["--version"]],
  ["status", ["status"]],
  [`context <id>`, ["context", probeId]],
  ["history <id>", ["history", probeId, "--limit", "50"]],
  ["log", ["log", "--limit", "50"]],
  ["search", ["search", "task"]],
  ["show <id>", ["show", probeId]],
  ["initiatives", ["initiatives"]],
  ["state", ["state"]],
  ["snapshots", ["snapshots"]],
];
const e2e: Array<{ label: string; ms: number; ok: boolean }> = [];
for (const [label, argv] of commands) {
  const samples: number[] = [];
  let ok = true;
  for (let i = 0; i < iterations; i += 1) {
    const result = run(argv);
    samples.push(result.ms);
    ok = ok && result.ok;
  }
  e2e.push({ label, ms: median(samples), ok });
}
const mutationSamples: number[] = [];
for (let i = 0; i < Math.min(iterations, 5); i += 1) {
  mutationSamples.push(run(["add-note", probeId, `bench ${i}`, "--as", "bench"]).ms);
}
e2e.push({ label: "add-note (mutación)", ms: median(mutationSamples), ok: true });

// --- layers ----------------------------------------------------------------
const stateAfter = await readSqliteState(sqliteFile) as Record<string, any>;
const rawNodes = JSON.stringify(stateAfter.nodes);
const rawEdges = JSON.stringify(stateAfter.edges);
const rawLog = JSON.stringify(stateAfter.log);
const layers: Array<{ label: string; ms: number }> = [
  { label: "readSqliteState (sin bodies)", ms: await timeAsync(() => readSqliteState(sqliteFile, { includeBodies: false })) },
  { label: "readSqliteState (con bodies)", ms: await timeAsync(() => readSqliteState(sqliteFile)) },
  { label: "readSqliteChangesSince(rev-10)", ms: await timeAsync(() => readSqliteChangesSince(sqliteFile, Math.max(0, (stateAfter.revision ?? 0) - 10))) },
  { label: "parse nodos (JSON.parse)", ms: timeSync(() => JSON.parse(rawNodes)) },
  { label: "parse edges (JSON.parse)", ms: timeSync(() => JSON.parse(rawEdges)) },
  { label: "parse log (JSON.parse)", ms: timeSync(() => JSON.parse(rawLog)) },
  { label: "validateStateInvariants", ms: timeSync(() => validateStateInvariants(stateAfter, "bench")) },
  { label: "createTransaction (clon del draft)", ms: timeSync(() => createTransaction(stateAfter)) },
  { label: "structuredClone(state)", ms: timeSync(() => structuredClone(stateAfter)) },
  { label: "projectStatusView", ms: timeSync(() => projectStatusView({ snapshot: stateAfter, filters: {}, now: Date.now() })) },
  { label: "projectContextView", ms: timeSync(() => projectContextView({ snapshot: stateAfter, id: probeId, agent: "bench", now: Date.now() })) },
  { label: "readState (wrapper de comando)", ms: await timeAsync(() => readState(projectDir, { includeBodies: false })) },
  { label: "withSqliteTransaction (abrir)", ms: await timeAsync(() => withSqliteTransaction(sqliteFile, async () => {})) },
  { label: "createBuiltinOperationRegistry", ms: timeSync(() => createBuiltinOperationRegistry()) },
  { label: "loadApplicablePolicy (boot)", ms: await timeAsync(() => loadApplicablePolicy({ projectDir })) },
  { label: "status in-process (sin spawn)", ms: await timeAsync(() => runCliInProcess(["status"], { cwd: projectDir, env })) },
  { label: "add-note in-process (sin spawn)", ms: await timeAsync(() => runCliInProcess(["add-note", probeId, "bench-ip", "--as", "bench"], { cwd: projectDir, env }), 3) },
];

// Boot: what a fresh process pays before the command does anything.
const dispatchUrl = new URL("../src/cli/dispatch.ts", import.meta.url).href;
const bootProbe = spawnSync(process.execPath, ["-e", `const t = performance.now(); await import(${JSON.stringify(dispatchUrl)}); globalThis.__t = performance.now() - t;`], { env, encoding: "utf8" });
const moduleGraph = (() => {
  const probe = spawnSync(process.execPath, ["-e", `const t=performance.now(); await import(${JSON.stringify(dispatchUrl)}); console.log((performance.now()-t).toFixed(2))`], { env, encoding: "utf8" });
  return Number(probe.stdout.trim());
})();

const copy = path.join(root, "write-probe.sqlite");
fs.copyFileSync(sqliteFile, copy);
layers.push({ label: "writeSqliteState (replace total)", ms: await timeAsync(() => writeSqliteState(copy, stateAfter, stateAfter), 3) });
layers.push({ label: "updateSqliteState (mutator no-op)", ms: await timeAsync(() => updateSqliteState(copy, (state) => state), 3) });

const report = {
  fixture,
  projectId,
  counts,
  fixtureBytes: fs.statSync(fixture).size,
  sqliteBytes: fs.statSync(sqliteFile).size,
  iterations,
  boot: { moduleGraphMs: moduleGraph, probeExit: bootProbe.status },
  e2e,
  layers,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`fixture: ${fixture}`);
  console.log(`estado: ${counts.nodes} nodos · ${counts.edges} edges · ${counts.log} log · ${counts.initiatives} iniciativas`);
  console.log(`bytes: fixture ${(report.fixtureBytes / 1048576).toFixed(2)} MB · sqlite ${(report.sqliteBytes / 1048576).toFixed(2)} MB · iteraciones ${iterations}`);
  const floor = e2e[0].ms;
  console.log(`boot: import del grafo de comandos ${moduleGraph.toFixed(1)} ms (proceso nuevo)`);
  console.log("\nE2E por comando (mediana, proceso completo)");
  console.log("comando".padEnd(22), "ms".padStart(7), "  − piso", "  estado");
  for (const row of e2e) {
    console.log(row.label.padEnd(22), row.ms.toFixed(1).padStart(7), (row.ms - floor).toFixed(1).padStart(8), row.ok ? "" : "  ERROR");
  }
  console.log("\nCapas (mediana, in-process)");
  console.log("capa".padEnd(34), "ms".padStart(8));
  for (const row of [...layers].sort((a, b) => b.ms - a.ms)) {
    console.log(row.label.padEnd(34), row.ms.toFixed(2).padStart(8));
  }
}

if (!keep) fs.rmSync(root, { recursive: true, force: true });
else console.log(`\n(temp home conservado: ${root})`);
