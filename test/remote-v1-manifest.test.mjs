import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBuiltinOperationRegistry,
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "../src/application/operations/builtins.mjs";
import { remoteV1CapabilityInventory } from "./fixtures/remote-v1-capability-inventory.mjs";
import { remoteV1Manifest } from "../src/application/operations/remote-v1-manifest.mjs";

const MANIFEST_PATH = fileURLToPath(new URL(
  "../src/application/operations/remote-v1-manifest.mjs",
  import.meta.url,
));

test("remote-v1 manifest is a versioned data-only projection of provider-backed capabilities", async () => {
  assert.equal(remoteV1Manifest.version, 1);
  assert.equal(Array.isArray(remoteV1Manifest.operations), true);
  assert.equal(remoteV1Manifest.operations.length, 21);

  const operationIds = remoteV1Manifest.operations.map(({ id }) => id);
  assert.equal(new Set(operationIds).size, 21);
  assert.equal(operationIds.includes("core.batch"), false);
  assert.deepEqual(
    [...operationIds].sort(),
    [...remoteV1CapabilityInventory.operations.map(({ id }) => id)].sort(),
  );

  const registry = createBuiltinOperationRegistry();
  const catalogIds = [
    ...PUBLIC_TASK_OPS,
    ...PUBLIC_GATE_OPS,
    ...PUBLIC_KNOWLEDGE_OPS,
    ...PUBLIC_CORE_OPS,
  ];
  assert.deepEqual([...operationIds].sort(), [...catalogIds].sort());
  for (const operation of remoteV1Manifest.operations) {
    const registered = registry.lookup(operation.id);
    assert.ok(registered, `${operation.id} is registered`);
    assert.equal(typeof registered.provider.prepare, "function");
    assert.equal(typeof registered.provider.apply, "function");
    assert.deepEqual(
      Object.keys(operation).sort(),
      ["batch", "httpFields", "id"],
      `${operation.id} contains only remote capability fields`,
    );
  }

  assert.deepEqual(
    remoteV1Manifest.operations,
    remoteV1CapabilityInventory.operations,
  );
  assert.deepEqual(Object.keys(remoteV1Manifest.batch).sort(), [
    "eligibleOperationIds",
    "id",
    "inputFields",
    "nestedBatches",
    "operationFields",
  ]);
  assert.equal(remoteV1Manifest.batch.id, "core.batch");
  assert.deepEqual(remoteV1Manifest.batch.inputFields, ["operations", "if_state_revision"]);
  assert.deepEqual(remoteV1Manifest.batch.operationFields, ["op", "input"]);
  assert.equal(remoteV1Manifest.batch.nestedBatches, false);
  assert.deepEqual(
    remoteV1Manifest.batch.eligibleOperationIds,
    remoteV1Manifest.operations.filter(({ batch }) => batch).map(({ id }) => id),
  );
  assert.deepEqual(
    remoteV1Manifest.batch.eligibleOperationIds,
    remoteV1CapabilityInventory.batch.eligibleOperationIds,
  );

  const serialized = JSON.parse(JSON.stringify(remoteV1Manifest));
  assert.deepEqual(serialized, remoteV1Manifest);
  assert.equal(Object.isFrozen(remoteV1Manifest), true);
  assert.equal(Object.isFrozen(remoteV1Manifest.operations), true);
  assert.equal(Object.isFrozen(remoteV1Manifest.batch), true);
  for (const operation of remoteV1Manifest.operations) {
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.httpFields), true);
  }
  assert.equal(Object.isFrozen(remoteV1Manifest.batch.inputFields), true);
  assert.equal(Object.isFrozen(remoteV1Manifest.batch.operationFields), true);
  assert.equal(Object.isFrozen(remoteV1Manifest.batch.eligibleOperationIds), true);

  const source = await fs.readFile(MANIFEST_PATH, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "manifest must not import adapters or providers");
  assert.doesNotMatch(source, /register|provider|adapter|router|bridge/i);
});

test("if_revision is only a superficial remote-v1 wire field", () => {
  const fieldsWithRevision = remoteV1Manifest.operations
    .filter(({ httpFields }) => httpFields.includes("if_revision"))
    .map(({ id }) => id);
  assert.deepEqual(
    fieldsWithRevision,
    remoteV1CapabilityInventory.operations
      .filter(({ httpFields }) => httpFields.includes("if_revision"))
      .map(({ id }) => id),
  );
  for (const operation of remoteV1Manifest.operations) {
    assert.equal(Object.hasOwn(operation, "if_revision"), false);
  }
});
