import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_COMMANDS } from "../src/cli/dispatch.ts";
import { UPDATE_PATCH_KEYS } from "../scripts/check-retired-surfaces.ts";

test("provider allowlists retain kind-specific fields", () => {
  assert.ok(UPDATE_PATCH_KEYS.task.includes("backlog"));
  assert.ok(!UPDATE_PATCH_KEYS.knowledge.includes("backlog"));
  assert.ok(UPDATE_PATCH_KEYS.gate.includes("purpose"));
  assert.ok(!UPDATE_PATCH_KEYS.task.includes("purpose"));
});

test("legacy top-level importer stays retired while explicit SQLite migration is scoped under state", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.ok(!KNOWN_COMMANDS.includes("migrate"));
  const { HELP_TEXT } = await import("../src/cli/dispatch.ts");
  assert.match(HELP_TEXT, /state migrate --as <agent> --yes/);
  assert.doesNotMatch(HELP_TEXT, /\n  migrate(?:\s|\n)/i);
  for (const relative of [
    "src/cli/commands/migrate.ts",
    "src/storage/migrate.ts",
    "src/storage/migrate-detection.ts",
  ]) {
    await assert.rejects(fs.access(path.join(root, relative)), { code: "ENOENT" });
  }
  await assert.doesNotReject(fs.access(path.join(root, "src/storage/sqlite/migrate.ts")));
});

test("retired command names stay out of the command table", () => {
  for (const command of ["add-decision", "add-gotcha"]) {
    assert.ok(!KNOWN_COMMANDS.includes(command), `${command} must stay retired`);
  }
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
