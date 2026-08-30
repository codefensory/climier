import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const pluginRoot = path.join(srcRoot, "plugins");
const modules = ["api", "query", "data", "core-adapter", "core-registry"];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("plugin API surfaces live under src/plugins without root plugin files", async () => {
  for (const name of modules) {
    assert.equal(await exists(path.join(pluginRoot, `${name}.mjs`)), true, `${name}.mjs is under src/plugins`);
    assert.equal(await exists(path.join(srcRoot, `plugin-${name}.mjs`)), false, `${name} has no root legacy module`);
  }
});
