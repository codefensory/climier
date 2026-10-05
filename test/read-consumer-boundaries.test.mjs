import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const files = {
  pluginQuery: new URL("../src/plugins/query.mjs", import.meta.url),
  uiApi: new URL("../src/server/http/ui-api.mjs", import.meta.url),
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

test("UI API consumes the UI read model instead of the v2 facade", async () => {
  const text = await source(files.uiApi);
  assert.match(text, /from ["']\.\.\/\.\.\/read-model\/ui\.mjs["']/);
  assert.doesNotMatch(text, /from ["']\.\.\/\.\.\/v2\.mjs["']/);
});
