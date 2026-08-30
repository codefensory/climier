import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const moduleName of ["lock", "log"]) {
  test(`${moduleName} storage has a canonical module and no root shim`, async () => {
    const storageModule = path.join(ROOT, "src", "storage", `${moduleName}.mjs`);
    const rootModule = path.join(ROOT, "src", `${moduleName}.mjs`);

    await assert.doesNotReject(() => fs.access(storageModule));
    await assert.rejects(() => fs.access(rootModule), { code: "ENOENT" });
  });
}
