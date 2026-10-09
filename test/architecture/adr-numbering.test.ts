import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";

test("ADR numeric prefixes are unique", async () => {
  const files = await readdir(".adrs");
  const numbers = files
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.match(/^(\d+)-/)?.[1])
    .filter((number) => number !== undefined);
  const duplicates = numbers.filter((number, index) => numbers.indexOf(number) !== index);

  assert.deepEqual(duplicates, [], "ADR numeric prefixes must not be reused");
});
