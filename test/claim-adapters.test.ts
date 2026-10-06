import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

test("take CLI command is a kernel adapter, not a persistence owner", async () => {
  const source = await fs.readFile(path.join(ROOT, "src", "cli", "commands", "take.ts"), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/kernel\/mutate\.ts"/);
  assert.match(source, /providers\/task\/take\.ts/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/state\.ts"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/lock\.ts"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/log\.ts"/);
  assert.doesNotMatch(source, /\.revision\s*=/);
  assert.doesNotMatch(source, /updateState|withLock|appendWithContext|readState/);
});

test("release CLI command uses the operation bridge, not persistence APIs", async () => {
  const source = await fs.readFile(path.join(ROOT, "src", "cli", "commands", "release.ts"), "utf8");
  assert.match(source, /createOperationBridge/);
  assert.match(source, /executeOperation\(/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/kernel\/mutate\.ts"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/state\.ts"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/lock\.ts"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/log\.ts"/);
  assert.doesNotMatch(source, /\.revision\s*=/);
  assert.doesNotMatch(source, /updateState|withLock|appendWithContext|readState/);
});

for (const command of ["resolve", "reopen", "cancel"]) {
  test(`${command} CLI command is a kernel adapter, not a persistence owner`, async () => {
    const source = await fs.readFile(path.join(ROOT, "src", "cli", "commands", `${command}.ts`), "utf8");
    assert.match(source, /from "\.\.\/\.\.\/kernel\/mutate\.ts"/);
    assert.match(source, /providers\/(task|gate)\//);
    assert.doesNotMatch(source, /from "\.\.\/\.\.\/state\.ts"/);
    assert.doesNotMatch(source, /from "\.\.\/\.\.\/lock\.ts"/);
    assert.doesNotMatch(source, /from "\.\.\/\.\.\/log\.ts"/);
    assert.doesNotMatch(source, /\.revision\s*=/);
    assert.doesNotMatch(source, /updateState|withLock|appendWithContext|readState/);
  });
}
