import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("state storage has a canonical module and no root shim", async () => {
  const storageState = path.join(ROOT, "src", "storage", "state.mjs");
  const rootState = path.join(ROOT, "src", "state.mjs");

  await assert.doesNotReject(() => fs.access(storageState));
  await assert.rejects(() => fs.access(rootState), { code: "ENOENT" });
});
