import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const files = {
  pluginQuery: new URL("../src/plugins/query.mjs", import.meta.url),
  uiServer: new URL("../ui/server/server.mjs", import.meta.url),
};

async function source(url) {
  return fs.readFile(url, "utf8");
}

test("plugin query consumes the read model instead of command or v2 facades", async () => {
  const text = await source(files.pluginQuery);
  assert.match(text, /from ["']\.\.\/read-model\/index\.mjs["']/);
  assert.doesNotMatch(text, /from ["']\.\/commands\//);
  assert.doesNotMatch(text, /from ["']\.\/v2\.mjs["']/);
});

test("UI server consumes the read model instead of the v2 facade", async () => {
  const text = await source(files.uiServer);
  assert.match(text, /from ["']\.\.\/\.\.\/src\/read-model\/index\.mjs["']/);
  assert.doesNotMatch(text, /from ["']\.\.\/\.\.\/src\/v2\.mjs["']/);
});
