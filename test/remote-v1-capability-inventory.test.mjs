import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltinOperationRegistry,
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "../src/application/operations/builtins.mjs";
import { remoteV1Manifest } from "../src/application/operations/remote-v1-manifest.mjs";
import { remoteV1CapabilityInventory } from "./fixtures/remote-v1-capability-inventory.mjs";

test("remote-v1 inventory matches the fixture, manifest, and provider catalog", () => {
  const catalogIds = [...PUBLIC_TASK_OPS, ...PUBLIC_GATE_OPS, ...PUBLIC_KNOWLEDGE_OPS, ...PUBLIC_CORE_OPS];
  const registry = createBuiltinOperationRegistry();
  const expectedIds = remoteV1CapabilityInventory.operations.map(({ id }) => id);
  assert.equal(expectedIds.length, 21);
  assert.equal(new Set(expectedIds).size, 21);
  assert.deepEqual([...registry.list()].sort(), [...catalogIds].sort());
  assert.deepEqual([...expectedIds].sort(), [...catalogIds].sort());
  assert.deepEqual([...remoteV1Manifest.operations].sort((left, right) => left.id.localeCompare(right.id)),
    [...remoteV1CapabilityInventory.operations].sort((left, right) => left.id.localeCompare(right.id)));
  assert.deepEqual([...remoteV1Manifest.operations.map(({ id }) => id)].sort(), [...catalogIds].sort());
  assert.equal(registry.has("core.batch"), false, "core.batch is a protocol envelope, not a registered provider");

  assert.deepEqual(remoteV1Manifest.batch, remoteV1CapabilityInventory.batch);
  assert.equal(remoteV1Manifest.batch.id, "core.batch");
  assert.equal(remoteV1Manifest.batch.nestedBatches, false);
  assert.deepEqual(
    remoteV1Manifest.batch.eligibleOperationIds,
    remoteV1Manifest.operations.filter(({ batch }) => batch).map(({ id }) => id),
  );
});
