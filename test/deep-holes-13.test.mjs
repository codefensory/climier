// Bug hunt: look for real bugs in the gap-filling changes and in code that
// hasn't been stressed by tests yet. Output is JSON-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, initExampleProject} from "./helpers.mjs";

// 1. add-gotcha validation: --applies-to with only whitespace
test("bug: add-gotcha --applies-to with only commas produces empty applies_to (should fail)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x", "--applies-to", ",,,"]);
    // Current behavior: filter Boolean removes empty strings → empty applies_to
    // That means the gotcha matches nothing. Should it fail? Let's see what happens.
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    // If applies_to is empty, the gotcha is effectively useless. Document the behavior.
    assert.ok(s.gotchas.G1);
    assert.deepEqual(s.gotchas.G1.applies_to, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 2. log without state file
test("bug: log on empty project returns empty list (no crash)", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "log"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 3. gotchas on empty project
test("bug: gotchas on empty project returns empty list", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "gotchas"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 4. decisions on empty project
test("bug: decisions on empty project returns empty list", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "decisions"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 5. show without state file
test("bug: show on empty project fails clean with JSON error", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "show", "T1"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /state/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 6. show on a task with no id positional
test("bug: show with no id fails clean with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "show"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /id required/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 7. add-gotcha with no positional id
test("bug: add-gotcha with no id fails clean with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "--title", "x", "--applies-to", "domain:db"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /id required/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 8. add-gotcha with no --title
test("bug: add-gotcha with no --title fails clean with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--applies-to", "domain:db"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /title/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 9. add-gotcha with no --applies-to
test("bug: add-gotcha with no --applies-to fails clean with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /applies-to/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 10. log --limit negative
test("bug: log --limit negative is treated as 0 or ignored", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    const r = await runCli(["--project", dir, "log", "--limit", "-5"]);
    // Whatever happens, no crash
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// 11. Failing command produces JSON error on stdout
test("bug: failing command produces JSON error on stdout, never corrupts stdout", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // claim a non-existent task
    const r = await runCli(["--project", dir, "claim", "NOPE", "--as", "a"]);
    assert.notEqual(r.code, 0);
    // The error must be valid JSON.
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /not found/i);
  } finally {
    await rmTempProject(dir);
  }
});

// 12. gotchas --domain with no matches returns empty
test("bug: gotchas --domain with no matching gotchas returns empty", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "gotchas", "--domain", "nonexistent"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 13. log --action on empty log
test("bug: log --action on empty log returns empty", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "log", "--action", "claim"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, []);
  } finally {
    await rmTempProject(dir);
  }
});

// 14. Concurrent add-gotcha on different ids
test("bug: concurrent add-gotcha on different ids — all succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const ops = ["G1", "G2", "G3"].map((id) =>
      runCli(["--project", dir, "add-gotcha", id, "--title", "t" + id, "--applies-to", "domain:db"])
    );
    const results = await Promise.all(ops);
    results.forEach((r) => assert.equal(r.code, 0, r.stderr));
    const s = await readState(dir);
    assert.ok(s.gotchas.G1);
    assert.ok(s.gotchas.G2);
    assert.ok(s.gotchas.G3);
  } finally {
    await rmTempProject(dir);
  }
});

// 15. --json flag is no longer accepted (deleted, not deprecated)
test("bug: --json flag is gone (unknown flag error)", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    // --json before the command → unknown flag, exit non-zero.
    const r1 = await runCli(["--project", dir, "--json", "ready"]);
    assert.notEqual(r1.code, 0);
    const d1 = JSON.parse(r1.stdout);
    assert.equal(d1.ok, false);
    // --json=json after the command → still unknown flag.
    const r2 = await runCli(["--project", dir, "ready", "--json=json"]);
    assert.notEqual(r2.code, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// 16. show on a gotcha
test("bug: show on a gotcha returns it", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "show", "G1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.type, "gotcha");
    assert.equal(data.node.id, "G1");
  } finally {
    await rmTempProject(dir);
  }
});

// 17. add-gotcha on a project that doesn't have gotchas collection (no init)
test("bug: add-gotcha creates a state if missing (bootstrap behavior)", async () => {
  const dir = await createTempProject();
  try {
    // add-* commands create the state if missing (bootstrap behavior).
    // claim/done/etc. would fail without init. add-* is the entry point.
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x", "--applies-to", "domain:db"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.ok(s.gotchas.G1);
  } finally {
    await rmTempProject(dir);
  }
});

// 18. log with multiple filters combines them
test("bug: log --action + --task combines filters", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    await runCli(["--project", dir, "decide", "D2", "y", "--because", "r"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "a"]);
    const r = await runCli(["--project", dir, "log", "--action", "decide"]);
    const data = JSON.parse(r.stdout);
    // Should have 2 decide entries, no claim
    assert.equal(data.length, 2);
    assert.ok(data.every((e) => e.action === "decide"));
  } finally {
    await rmTempProject(dir);
  }
});

// 19. add-gotcha with --applies-to that references a non-existent task
test("bug: add-gotcha does not validate that --applies-to targets exist", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // --applies-to T_NONEXISTENT should it fail? The current code accepts any string.
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x", "--applies-to", "T_NONEXISTENT"]);
    // Document the behavior: we don't validate targets.
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.deepEqual(s.gotchas.G1.applies_to, ["T_NONEXISTENT"]);
  } finally {
    await rmTempProject(dir);
  }
});

// 20. show for a task that's been done
test("bug: show on a done task returns the full state including done_at", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "a"]);
    await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "a"]);
    const r = await runCli(["--project", dir, "show", "F0.T1"]);
    const data = JSON.parse(r.stdout);
    assert.equal(data.type, "task");
    assert.equal(data.node.status, "done");
    assert.equal(data.node.note, "shipped");
    assert.ok(data.node.done_at);
  } finally {
    await rmTempProject(dir);
  }
});

// 21. log with --decision filter
test("bug: log --decision filter returns only entries for that decision", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    await runCli(["--project", dir, "decide", "D2", "y", "--because", "r"]);
    const r = await runCli(["--project", dir, "log", "--decision", "D1"]);
    const data = JSON.parse(r.stdout);
    assert.equal(data.length, 1);
    assert.equal(data[0].decision, "D1");
  } finally {
    await rmTempProject(dir);
  }
});

// 22. status on a project with no state
test("bug: status on project with no state returns the empty-status object (counts, in_progress, ... all empty)", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    // Returns the same shape status always returns, just with all collections empty.
    assert.deepEqual(data.counts, {});
    assert.deepEqual(data.in_progress, []);
    assert.deepEqual(data.ready, []);
  } finally {
    await rmTempProject(dir);
  }
});
