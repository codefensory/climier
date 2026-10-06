import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.ts";
import {
  collectCatalogs,
  catalogFingerprint,
  renderGeneratedFiles,
} from "../scripts/gen-types.ts";
import {
  GENERATED_CATALOG,
  GENERATED_CATALOG_FINGERPRINT,
} from "../src/contracts/generated/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GENERATED_DIR = path.join(ROOT, "src", "contracts", "generated");
const TYPE_PROJECTS = [
  "tsconfig.contracts.json",
  "tsconfig.storage.json",
  "tsconfig.kernel.json",
  "tsconfig.providers.json",
  "tsconfig.read-model.json",
  "tsconfig.application.json",
  "tsconfig.plugins.json",
  "tsconfig.server.json",
  "tsconfig.cli.json",
];

async function currentCatalogs() {
  return collectCatalogs(ROOT);
}

function parseTsConfig(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

test("every TypeScript project in the build graph enables strict checking", async () => {
  for (const filename of TYPE_PROJECTS) {
    const config = parseTsConfig(await fs.readFile(path.join(ROOT, filename), "utf8"));
    assert.equal(config.compilerOptions.strict, true, `${filename} must enable strict checking`);
  }
});

test("generated type catalogs are deterministic", async () => {
  const first = await currentCatalogs();
  const second = await currentCatalogs();

  assert.deepEqual(first, second);
  const rendered = renderGeneratedFiles(first);
  assert.deepEqual(rendered, renderGeneratedFiles(second));
  assert.equal(GENERATED_CATALOG_FINGERPRINT, catalogFingerprint(first));
  for (const [name, content] of Object.entries(rendered)) {
    assert.equal(await fs.readFile(path.join(GENERATED_DIR, name), "utf8"), content, `${name} is stale`);
  }
});

test("generated error and command catalogs match their runtime source catalogs", async () => {
  const catalogs = await currentCatalogs();

  assert.deepEqual(GENERATED_CATALOG.errorCodesByDomain, catalogs.errorCodesByDomain);
  assert.deepEqual(GENERATED_CATALOG.errorCodes, catalogs.errorCodes);
  assert.deepEqual(GENERATED_CATALOG.commandFlags, catalogs.commandFlags);
});

test("generated operations match the live built-in registry", async () => {
  const registry = createBuiltinOperationRegistry();
  const liveOperations = registry.ops.map((id) => ({ id, kind: registry.lookup(id).kind }));

  assert.deepEqual(GENERATED_CATALOG.operations, liveOperations);
});
