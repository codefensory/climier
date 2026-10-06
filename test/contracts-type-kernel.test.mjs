import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = path.join(ROOT, "src", "contracts");

const EXPECTED_DOMAIN_SIZES = Object.freeze({
  core: 19,
  storage: 15,
  remote: 9,
  plugin: 6,
  cli: 3,
});

for (const file of ["agent.ts", "errors.ts", "domain.ts", "operations.ts", "state-invariants.ts"]) {
  test(`contracts/${file} is a runtime-independent leaf`, async () => {
    const source = await fs.readFile(path.join(CONTRACT_DIR, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*\.\.\/[^"']*["']/u);
    assert.doesNotMatch(source, /from\s+["'][^"']*src\//u);
  });
}

test("error contract keeps the canonical 52-code domain catalog in sync", async () => {
  const {
    ERROR_CODES_BY_DOMAIN,
    ERROR_CODES,
  } = await importFresh("../src/contracts/errors.ts");

  assert.deepEqual(
    Object.fromEntries(Object.entries(ERROR_CODES_BY_DOMAIN).map(([domain, codes]) => [domain, Object.keys(codes).length])),
    EXPECTED_DOMAIN_SIZES,
  );
  assert.equal(Object.keys(ERROR_CODES).length, 52);
  assert.equal(new Set(Object.values(ERROR_CODES)).size, 52);

  for (const [domain, codes] of Object.entries(ERROR_CODES_BY_DOMAIN)) {
    for (const [name, value] of Object.entries(codes)) {
      assert.equal(value, name, `${domain}.${name} must be self-describing`);
      assert.equal(ERROR_CODES[name], value, `${domain}.${name} is missing from the aggregate catalog`);
    }
  }
});

test("ClimierError and throwV2 expose the structured error envelope", async () => {
  const { ClimierError, makeError, throwV2 } = await importFresh("../src/contracts/errors.ts");
  const details = { field: "id" };
  const direct = new ClimierError("NODE_NOT_FOUND", "node is missing", details);

  assert.ok(direct instanceof Error);
  assert.equal(direct.code, "NODE_NOT_FOUND");
  assert.deepEqual(direct.details, details);
  assert.deepEqual(direct.toJSON(), makeError("NODE_NOT_FOUND", "node is missing", details));

  assert.throws(
    () => throwV2("MISSING_FIELD", "id is required", details),
    (error) => error instanceof ClimierError
      && error.code === "MISSING_FIELD"
      && error.details.field === "id",
  );
});

async function importFresh(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  url.searchParams.set("fresh", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}
