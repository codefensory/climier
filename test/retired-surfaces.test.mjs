import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_COMMANDS } from "../src/cli/dispatch.ts";
import { scanRetiredSurfaces, UPDATE_PATCH_KEYS } from "../scripts/check-retired-surfaces.ts";

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-retired-surfaces-"));
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "steps: []\n");
  return root;
}

test("retired surface checker derives the contract and catches removed flags and history fields", async () => {
  const root = await fixtureRoot();
  await fs.writeFile(path.join(root, "docs-reference.md"), "");
  await fs.writeFile(path.join(root, "docs", "reference.md"), "### `take <id>`\n- `--as`\n- `--initiative`\nentry.task\n").catch(async (error) => {
    if (error.code !== "ENOENT") {throw error;}
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "reference.md"), "### `take <id>`\n- `--as`\n- `--initiative`\nentry.task\n");
  });
  const result = await scanRetiredSurfaces({ root });
  assert.ok(result.issues.some((line) => line.includes("take: --initiative")));
  assert.ok(result.issues.some((line) => line.includes("entry.task")));
});

test("provider allowlists retain kind-specific fields", () => {
  assert.ok(UPDATE_PATCH_KEYS.task.includes("backlog"));
  assert.ok(!UPDATE_PATCH_KEYS.knowledge.includes("backlog"));
  assert.ok(UPDATE_PATCH_KEYS.gate.includes("purpose"));
  assert.ok(!UPDATE_PATCH_KEYS.task.includes("purpose"));
});

test("manual transfer CLI and remote v1 manifest remain registered", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.ok(KNOWN_COMMANDS.includes("login"));
  assert.ok(KNOWN_COMMANDS.includes("logout"));
  assert.ok(KNOWN_COMMANDS.includes("link"));
  assert.ok(KNOWN_COMMANDS.includes("push"));
  assert.ok(KNOWN_COMMANDS.includes("pull"));
  for (const relative of ["src/cli/commands/push.ts", "src/cli/commands/pull.ts"]) {
    await assert.doesNotReject(fs.access(path.join(root, relative)));
  }
  await assert.doesNotReject(fs.access(path.join(root, "src/application/operations/remote-v1-manifest.ts")));
});

test("retired surface checker passes the repository sources", async () => {
  const result = await scanRetiredSurfaces();
  assert.deepEqual(result.issues, []);
});
