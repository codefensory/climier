import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("dispatch boot does not statically load local operation and state graphs", () => {
  const dispatchSource = fs.readFileSync(path.join(ROOT, "src/cli/dispatch.ts"), "utf8");
  assert.doesNotMatch(
    dispatchSource,
    /from ["'](?:\.\.\/(?:application\/operations\/index|operation-source|storage\/state)|\.\/commands\/reserved-namespaces)\.ts["']/,
  );

  const statusSource = fs.readFileSync(path.join(ROOT, "src/cli/commands/status.ts"), "utf8");
  assert.doesNotMatch(statusSource, /from ["']\.\.\/\.\.\/read-model\/index\.ts["']/);
  assert.match(statusSource, /from ["']\.\.\/\.\.\/read-model\/status\.ts["']/);
});
