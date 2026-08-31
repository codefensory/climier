import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const REGISTRY_MODULE = "../src/application/operations/registry.mjs";
const INDEX_MODULE = "../src/application/operations/index.mjs";

function provider() {
  return Object.freeze({
    prepare() {},
    apply() {},
  });
}

function entry(id, kind = "task") {
  return { id, kind, provider: provider() };
}

test("application operation registry is exported from the boundary and is adapter-independent", async () => {
  const registry = await importFresh(REGISTRY_MODULE);
  const boundary = await importFresh(INDEX_MODULE);

  assert.equal(typeof registry.buildRegistry, "function");
  assert.equal(typeof boundary.buildRegistry, "function");
  assert.equal(typeof boundary.createBuiltinOperationRegistry, "function");
  assert.equal(typeof boundary.bootstrapBuiltins, "function");
  assert.equal(typeof boundary.executeOperation, "function");
  const source = await import("node:fs/promises");
  const url = await import("node:url");
  const file = url.fileURLToPath(new URL(REGISTRY_MODULE, import.meta.url));
  const contents = await source.readFile(file, "utf8");
  assert.doesNotMatch(contents, /(?:plugins|commands|filesystem|node:fs|fs\/promises|kernel\/mutate)/);
});

test("buildRegistry exposes immutable get/has/list lookup over validated entries", async () => {
  const { buildRegistry } = await importFresh(REGISTRY_MODULE);
  const reg = buildRegistry([
    entry("task.create"),
    entry("gate.resolve", "gate"),
    entry("task.update"),
  ]);

  assert.equal(reg.has("task.create"), true);
  assert.equal(reg.get("task.create").id, "task.create");
  assert.equal(reg.lookup("missing"), null);
  assert.deepEqual(reg.list(), ["task.create", "gate.resolve", "task.update"]);
  assert.deepEqual(reg.list("task"), ["task.create", "task.update"]);
  assert.deepEqual(reg.list("missing"), []);

  const listed = reg.list();
  listed.push("not.registered");
  assert.deepEqual(reg.list(), ["task.create", "gate.resolve", "task.update"]);
});

test("buildRegistry keeps deterministic structured validation and duplicate errors", async () => {
  const { buildRegistry } = await importFresh(REGISTRY_MODULE);
  assert.throws(
    () => buildRegistry([entry("same"), entry("same")]),
    (error) => error.code === "REGISTRY_DUPLICATE_ID" &&
      error.details.first_index === 0 && error.details.second_index === 1,
  );
  assert.throws(
    () => buildRegistry([{ id: "bad", kind: "task", provider: {} }]),
    (error) => error.code === "REGISTRY_INVALID_PROVIDER" &&
      error.details.index === 0,
  );
});
