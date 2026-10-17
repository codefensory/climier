// resolve: a gate whose resolution_mode is not "choice" closes without a
// recorded decision, and the retired --note flag is rejected instead of
// being silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.ts";

async function withGate(mode, fn) {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "work", "--as", "alice"]);
    await runCli([
      "--project", dir, "add-gate", "G-1", "--initiative", "work",
      "--title", "gate", "--body", "body", "--purpose", "approval",
      "--resolution-mode", mode, "--as", "alice",
    ]);
    await fn(dir);
  } finally {
    await rmTempProject(dir);
  }
}

test("resolve: a labor gate resolves without --choice/--rationale", async () => {
  await withGate("labor", async (dir) => {
    const out = await runCli(["--project", dir, "resolve", "G-1", "--as", "alice"]);
    assert.equal(out.code, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.equal(payload.node.status, "resolved");
    assert.equal(payload.node.resolution, null);
    assert.deepEqual(payload.node.resolution, null);
  });
});

test("resolve: a choice gate still requires both flags", async () => {
  await withGate("choice", async (dir) => {
    const out = await runCli(["--project", dir, "resolve", "G-1", "--as", "alice"]);
    assert.equal(out.code, 1);
    assert.equal(JSON.parse(out.stdout).error.code, "MISSING_FIELD");
  });
});

test("resolve: --note is not a flag", async () => {
  await withGate("choice", async (dir) => {
    const out = await runCli([
      "--project", dir, "resolve", "G-1", "--choice", "c", "--rationale", "r", "--note", "n", "--as", "alice",
    ]);
    assert.equal(out.code, 2);
    const error = JSON.parse(out.stdout).error;
    assert.equal(error.code, "CLI_USAGE_ERROR");
    assert.deepEqual(error.details.flag, "note");
  });
});
