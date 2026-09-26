import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBuiltinOperationRegistry, PUBLIC_CORE_OPS, PUBLIC_GATE_OPS, PUBLIC_KNOWLEDGE_OPS, PUBLIC_TASK_OPS } from "../src/application/operations/builtins.mjs";
import { remoteV1CapabilityInventory } from "./fixtures/remote-v1-capability-inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseSetEntries(source, name) {
  const declaration = source.match(new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  assert.ok(declaration, `${name} declaration exists`);
  return new Map([...declaration[1].matchAll(/"([^"]+)": new Set\(\[([^\]]*)\]\)/g)].map(([, id, fields]) => [
    id,
    [...fields.matchAll(/"([^"]+)"/g)].map(([, field]) => field),
  ]));
}

function parseNamedSet(source, name) {
  const declaration = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\);`));
  assert.ok(declaration, `${name} declaration exists`);
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, field]) => field);
}

test("remote-v1 inventory fixes provider-backed IDs, HTTP fields, and batch eligibility", async () => {
  const catalogIds = [...PUBLIC_TASK_OPS, ...PUBLIC_GATE_OPS, ...PUBLIC_KNOWLEDGE_OPS, ...PUBLIC_CORE_OPS];
  const registry = createBuiltinOperationRegistry();
  const expectedIds = remoteV1CapabilityInventory.operations.map(({ id }) => id);
  assert.equal(expectedIds.length, 21);
  assert.equal(new Set(expectedIds).size, 21);
  assert.deepEqual([...registry.list()].sort(), [...catalogIds].sort());
  assert.deepEqual([...expectedIds].sort(), [...catalogIds].sort());
  assert.deepEqual(remoteV1CapabilityInventory.operations.map(({ batch }) => batch), Array(21).fill(true));
  assert.equal(registry.has("core.batch"), false, "core.batch is a protocol envelope, not a registered provider");

  const serverSource = await fs.readFile(path.join(ROOT, "src/server/http.mjs"), "utf8");
  assert.match(serverSource, /const OPERATION_IDS = new Set\(\[\s*\.\.\.PUBLIC_TASK_OPS,\s*\.\.\.PUBLIC_GATE_OPS,\s*\.\.\.PUBLIC_KNOWLEDGE_OPS,\s*\.\.\.PUBLIC_CORE_OPS,\s*\]\);/);
  assert.match(serverSource, /!OPERATION_IDS\.has\(operation\.op\).*operation\.op === "core\.batch"/s);
  const httpFields = parseSetEntries(serverSource, "ALLOWED_INPUT_FIELDS");
  assert.deepEqual([...httpFields.keys()].sort(), [...expectedIds].sort());
  for (const { id, httpFields: fields } of remoteV1CapabilityInventory.operations) {
    assert.deepEqual([...fields].sort(), [...httpFields.get(id)].sort(), `${id} HTTP input fields`);
  }
  assert.deepEqual(parseNamedSet(serverSource, "BATCH_TOP_LEVEL_FIELDS"), remoteV1CapabilityInventory.batch.inputFields);
  assert.deepEqual(parseNamedSet(serverSource, "BATCH_OPERATION_FIELDS"), remoteV1CapabilityInventory.batch.operationFields);
  assert.equal(remoteV1CapabilityInventory.batch.id, "core.batch");
  assert.equal(remoteV1CapabilityInventory.batch.nestedBatches, false);
  assert.deepEqual(
    remoteV1CapabilityInventory.batch.eligibleOperationIds,
    remoteV1CapabilityInventory.operations.filter(({ batch }) => batch).map(({ id }) => id),
  );
});
