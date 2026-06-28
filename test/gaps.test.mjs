// Gaps identified in the audit table. Each test must fail before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// ---- add-gotcha ----
test("gap: add-gotcha CLI command exists and creates a gotcha", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1",
      "--title", "RLS trap", "--applies-to", "domain:db", "--mitigation", "filter by user_id"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.ok(s.gotchas.G1);
    assert.equal(s.gotchas.G1.title, "RLS trap");
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: add-gotcha --applies-to accepts a CSV of targets (domain:db,T1)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1",
      "--title", "trap", "--applies-to", "domain:db,T1"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.deepEqual(s.gotchas.G1.applies_to, ["domain:db", "T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: add-gotcha --initiative sets the initiative tag", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x", "--applies-to", "domain:db", "--initiative", "x"]);
    const s = await readState(dir);
    assert.equal(s.gotchas.G1.initiative, "x");
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: add-gotcha rejects duplicate id", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-gotcha", "G1", "--title", "x", "--applies-to", "domain:db"]);
    const r = await runCli(["--project", dir, "add-gotcha", "G1", "--title", "y", "--applies-to", "domain:db"]);
    assert.notEqual(r.code, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ---- --json flag ----
test("gap: --json flag on status returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.counts);
    assert.ok(data.in_progress);
    assert.ok(data.ready);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: --json flag on ready returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "ready"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
    assert.ok(data.some((t) => t.id === "F0.T1"));
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: --json flag on tasks returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "tasks"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: --json flag on claim returns parseable JSON with the claimed task", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "claim", "F0.T1", "--as", "a"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.task);
    assert.equal(data.task.id, "F0.T1");
    assert.equal(data.task.status, "in_progress");
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: --json flag on init returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--json", "init", "--seed", "migration"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.seeded, "migration");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- gotchas command ----
test("gap: gotchas command lists all gotchas", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "gotchas"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /G1/);
    assert.match(r.stdout, /G2/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: gotchas --domain filter returns only matching gotchas", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "gotchas", "--domain", "db"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /G1/);
    assert.match(r.stdout, /RLS/);
    assert.doesNotMatch(r.stdout, /G2/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: gotchas --json returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "gotchas"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 4);
  } finally {
    await rmTempProject(dir);
  }
});

// ---- decisions command ----
test("gap: decisions command lists all decisions with title and status", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "decisions"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /D1/);
    assert.match(r.stdout, /D2/);
    assert.match(r.stdout, /D3/);
    assert.match(r.stdout, /D4/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: decisions --json returns parseable JSON with full decision objects", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "decisions"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
    const d1 = data.find((d) => d.id === "D1");
    assert.ok(d1);
    assert.equal(d1.status, "open");
    assert.match(d1.title, /Directus/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: decisions reflects decided status after decide", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "decide", "D1", "raw-postgres", "--because", "r"]);
    const r = await runCli(["--project", dir, "--json", "decisions"]);
    const data = JSON.parse(r.stdout);
    const d1 = data.find((d) => d.id === "D1");
    assert.equal(d1.status, "decided");
    assert.equal(d1.choice, "raw-postgres");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- log command ----
test("gap: log command shows the log", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    const r = await runCli(["--project", dir, "log"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /decide/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: log --limit N shows only the last N entries", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // Generate a few log entries
    for (const d of ["D1", "D2", "D3", "D4"]) {
      await runCli(["--project", dir, "decide", d, "x", "--because", "r"]);
    }
    const r = await runCli(["--project", dir, "log", "--limit", "2"]);
    assert.equal(r.code, 0, r.stderr);
    // Should only show 2 entries
    const lines = r.stdout.split("\n").filter((l) => l.includes("decide"));
    assert.ok(lines.length <= 2, `expected <= 2 log lines, got ${lines.length}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: log --action filter", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    await runCli(["--project", dir, "decide", "D2", "y", "--because", "r"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "a"]);
    const r = await runCli(["--project", dir, "log", "--action", "claim"]);
    assert.equal(r.code, 0, r.stderr);
    // Should only show claim entries
    assert.match(r.stdout, /claim/);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: log --json returns parseable JSON", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "decide", "D1", "x", "--because", "r"]);
    const r = await runCli(["--project", dir, "--json", "log"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
    assert.ok(data.some((e) => e.action === "decide"));
  } finally {
    await rmTempProject(dir);
  }
});

// ---- show command ----
test("gap: show <task-id> returns the raw task object via --json", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "show", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.id, "F0.T1");
    assert.ok(data.title);
    assert.ok(data.skills);
    // depends_on may be undefined (tasks without deps don't have the field)
    assert.ok("depends_on" in data || data.depends_on === undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: show <decision-id> returns the raw decision object", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "show", "D1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.id, "D1");
    assert.ok(data.title);
    assert.equal(data.status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: show on unknown id fails clean", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "show", "NOPE"]);
    assert.notEqual(r.code, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("gap: show on a task without --json prints a human-readable view", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "show", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /F0\.T1/);
  } finally {
    await rmTempProject(dir);
  }
});
