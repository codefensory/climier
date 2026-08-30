import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

test("transitional v2 facade is removed", async () => {
  await assert.rejects(
    access(path.join(ROOT, "src", "v2.mjs")),
    { code: "ENOENT" },
  );
});

for (const command of ["status", "context"]) {
  test(`${command} command consumes the canonical read-model instead of v2`, async () => {
    const source = await readFile(path.join(ROOT, "src", "commands", `${command}.mjs`), "utf8");

    assert.match(source, /from ["']\.\.\/read-model\/index\.mjs["']/,
      `${command} must import projections from read-model`);
    assert.doesNotMatch(source, /from ["']\.\.\/v2\.mjs["']/,
      `${command} must not import the transitional v2 facade`);
  });
}
