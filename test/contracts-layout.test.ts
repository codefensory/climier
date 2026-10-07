import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of ["agent", "errors", "domain", "operations"]) {
  test(`${name} contract has a canonical module and no root shim`, async () => {
    const contractModule = path.join(ROOT, "src", "contracts", `${name}.ts`);
    const rootModule = path.join(ROOT, "src", `${name}.ts`);

    await assert.doesNotReject(() => fs.access(contractModule));
    await assert.rejects(() => fs.access(rootModule), { code: "ENOENT" });
  });
}
