import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "../../helpers.mjs";
import { bootstrapProject, importKernel, createTaskProvider } from "./helpers.mjs";

test("kernel.mutate: rejects invalid request (missing action)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { actor: "alice" }, // missing action
        provider: { prepare: async () => ({}), apply: async () => ({ result: null }) },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "action");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: rejects invalid provider (non-function apply)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: { prepare: async () => ({}), apply: "not a function" },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "apply");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: rejects plan missing target.id", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: { prepare: async () => ({ target: {} }), apply: async () => ({ result: null }) },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "target.id");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: throws when state file is missing (provider kernel does not bootstrap except initiative.create)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    // Bootstrap metadata only — no tasks.json yet.
    const { ensureProjectMeta } = await importFresh("./storage/state.mjs");
    await ensureProjectMeta(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: createTaskProvider({ id: "T-no-state", title: "x" }),
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /state file missing or not v5/);
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: source file does not import providers/registry/adapter/bin/ui or forbidden dirs", async () => {
  const fsp = await import("node:fs/promises");
  const fpath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = fpath.dirname(fileURLToPath(import.meta.url));
  const src = await fsp.readFile(fpath.resolve(__dirname, "..", "..", "..", "src", "kernel", "mutate.mjs"), "utf8");
  // Forbidden patterns: anything that would couple the kernel to
  // providers, registry, adapter, bin, UI, or std modules that are not
  // allowed. The plan's B1b explicitly grants `src/storage/state.mjs`,
  // `src/lock.mjs`, and `src/log.mjs` (atomicity primitives + log
  // shaping) and `src/kernel/transaction.mjs` (the existing draft) is
  // the whole point of B1b; those imports are required.
  const forbiddenPatterns = [
    /from\s+["'](node:fs|fs|fs\/promises|path|child_process|crypto|os|stream|util|events)["']/,
    /from\s+["']\.\.\/(paths|plugin|v2|commands|ui|agent|execution-contract|providers)["']/,
    /from\s+["']\.\.?\/(plugin-core-(adapter|registry))["']/,
    /from\s+["']\.\.\/bin\//,
  ];
  // Allowed relative imports — see the task body / ADR-011 §1: the
  // kernel must compose the existing allowed seams.
  const allowedRelative = new Set([
    "../contracts/errors.mjs", // throwV2 for structured errors
    "../storage/state.mjs", // readState + writeState (atomic)
    "../storage/lock.mjs",          // withLock (single-mutation frontier)
    "../storage/log.mjs",           // prepareLogEntry (canonical log shape)
    "./transaction.mjs",    // createTransaction (the existing draft)
    "./mutation/request.mjs", // extracted request/provider/plan contracts
    "./mutation/preconditions.mjs", // extracted CAS precondition contracts
    "./mutation/execute.mjs", // mutation execution coordinator
    "./mutation/diff.mjs", // snapshot-vs-draft diff
    "./mutation/revisions.mjs", // pure revision assignment and lookup
    "./mutation/validation.mjs", // final draft and log-field validation
    "./mutation/log-entry.mjs", // pure mutation log construction
  ]);
  const allRelative = [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
  for (const rel of allRelative) {
    assert.ok(allowedRelative.has(rel), `kernel/mutate.mjs imported forbidden module: ${rel}`);
  }
  for (const p of forbiddenPatterns) {
    assert.doesNotMatch(src, p, `kernel/mutate.mjs must not import forbidden module`);
  }
});
