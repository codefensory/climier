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
async function currentCatalogs() {
  return collectCatalogs(ROOT);
}

function parseTsConfig(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

test("the single TypeScript config has the intended checking options", async () => {
  const config = parseTsConfig(await fs.readFile(path.join(ROOT, "tsconfig.json"), "utf8"));
  const { compilerOptions } = config;

  assert.equal(compilerOptions.target, "ES2023");
  assert.equal(compilerOptions.module, "NodeNext");
  assert.equal(compilerOptions.moduleResolution, "NodeNext");
  assert.deepEqual(compilerOptions.lib, ["ES2023"]);
  assert.deepEqual(compilerOptions.types, ["node"]);
  assert.equal(compilerOptions.allowImportingTsExtensions, true);
  assert.equal(compilerOptions.resolveJsonModule, true);
  assert.equal(compilerOptions.esModuleInterop, true);
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.noImplicitAny, false);
  assert.equal(compilerOptions.noEmit, true);
  assert.equal(compilerOptions.skipLibCheck, true);
  assert.equal("composite" in compilerOptions, false);
  assert.equal("declaration" in compilerOptions, false);
  assert.equal("emitDeclarationOnly" in compilerOptions, false);
});

test("the root has no TypeScript project split", async () => {
  const configs = (await fs.readdir(ROOT))
    .filter((filename) => /^tsconfig.*\.json$/.test(filename))
    .sort();

  assert.deepEqual(configs, ["tsconfig.json"]);
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
  const liveOperations = registry.ops.map((id) => {
    const entry = registry.lookup(id);
    assert.ok(entry);
    return { id, kind: entry.kind };
  });

  assert.deepEqual(GENERATED_CATALOG.operations, liveOperations);
});
