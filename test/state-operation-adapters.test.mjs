import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);

for (const command of ["init", "restore"]) {
  test(`${command} command is a kernel state-operation adapter`, async () => {
    const source = await fs.readFile(path.join(root, "src", "commands", `${command}.mjs`), "utf8");
    assert.match(source, /kernel\/state-operations\.mjs/);
    assert.doesNotMatch(source, /from "\.\.\/lock\.mjs"/);
    assert.doesNotMatch(source, /from "\.\.\/log\.mjs"/);
    assert.doesNotMatch(source, /from "node:fs/);
    assert.doesNotMatch(source, /\b(?:withLock|writeState|updateState|append|createSnapshot)\s*\(/);
  });
}
