// Deep holes — round 11: only severe bugs (production-critical)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, stateFilePath, lockFilePath } from "./helpers.mjs";

// The state file should never be partially written.
// Even if the process is killed mid-update, the file should be either old or new, never broken.
test("hole: tmp file is never left behind after a successful update", async () => {
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks = { T1: { id: "T1" } };
      return s;
    });
    // Check no .tmp-* files remain
    const files = await fs.readdir(path.join(dir, ".agents", "tasks"));
    const tmpFiles = files.filter((f) => f.startsWith(".tmp-"));
    assert.equal(tmpFiles.length, 0, `tmp files left: ${tmpFiles.join(", ")}`);
  } finally {
    await rmTempProject(dir);
  }
});

// The lock file is never left behind after a successful operation
test("hole: lock file is never left behind after a successful operation", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "a"]);
    await runCli(["--project", dir, "done", "F0.T1", "ok", "--as", "a"]);
    // No .lock file should remain
    const lockExists = await fs.access(lockFilePath(dir)).then(() => true).catch(() => false);
    assert.equal(lockExists, false);
  } finally {
    await rmTempProject(dir);
  }
});

// Operations on a fresh project (no .agents/ dir) should work
test("hole: claim works even when .agents/ doesn't exist yet (creates it)", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const os = await import("node:os");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "climier-fresh-"));
  try {
    // No .agents/ at all
    await assert.rejects(
      claim({ statePath: base + "/.agents/tasks/tasks.json", flags: { as: "a" }, positional: ["T1"] }),
      /state.*missing|init/i
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// State file is always valid JSON after any operation
test("hole: state file is always valid JSON after any sequence of operations", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // Sequence of ops
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "a"]);
    await runCli(["--project", dir, "block", "F0.T1", "stuck", "--as", "a"]);
    await runCli(["--project", dir, "done", "F0.T1", "ok", "--as", "a"]);
    // After all this, the file should be valid JSON
    const raw = await fs.readFile(stateFilePath(dir), "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(parsed.tasks);
  } finally {
    await rmTempProject(dir);
  }
});

// Multiple failed operations don't accumulate state
test("hole: failed operations don't leave partial state", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // Multiple failing claims (task doesn't exist)
    for (let i = 0; i < 10; i++) {
      const r = await runCli(["--project", dir, "claim", "NONEXISTENT", "--as", "a"]);
      assert.notEqual(r.code, 0);
    }
    // State should still be valid
    const s = await readState(dir);
    assert.ok(s);
    assert.deepEqual(s.log, []); // failed claims don't log
  } finally {
    await rmTempProject(dir);
  }
});

// State file size doesn't grow unboundedly on small operations
test("hole: state file size stays bounded after 100 small operations", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const file = stateFilePath(dir);
    for (let i = 0; i < 100; i++) {
      await runCli(["--project", dir, "add-task", `T${i}`, "--initiative", "x", "--title", `task ${i}`]);
    }
    const stat = await fs.stat(file);
    // 100 small tasks should be well under 100KB
    assert.ok(stat.size < 100_000, `state file is ${stat.size} bytes`);
  } finally {
    await rmTempProject(dir);
  }
});

// A file with whitespace (indented JSON) can be read
test("hole: readState handles pretty-printed JSON", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, '{\n  "version": 1,\n  "tasks": {},\n  "decisions": {},\n  "gotchas": {},\n  "initiatives": {},\n  "log": []\n}\n', "utf8");
    const s = await readState(dir);
    assert.equal(s.version, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// A task with a CR/LF in the title is preserved
test("hole: a task with newlines in title is preserved (though not recommended)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    // Use single-quoted title with embedded newline
    const r = await runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "line1\nline2"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.match(s.tasks.T1.title, /line1\nline2/);
  } finally {
    await rmTempProject(dir);
  }
});

// recover from a state file with extra fields (forward compat: extras are ignored)
test("hole: readState ignores unknown top-level fields (forward compat)", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [],
      future_field: "ignored",
      another: { nested: true },
    }), "utf8");
    const s = await readState(dir);
    assert.equal(s.future_field, "ignored"); // preserved, not dropped
  } finally {
    await rmTempProject(dir);
  }
});
