import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

test("standalone UI decision records its gate and embedded asset strategy", () => {
  const adr = read(".adrs/072-embedded-ui-in-standalone-binary.md");
  assert.match(adr, /G-ui-embed-binary/u);
  assert.match(adr, /--asset ui\/dist/u);
  assert.match(adr, /uiRoot/u);
});

test("installation and self-hosting docs explain the standalone UI and optional custom root", () => {
  const install = read("docs/content/docs/getting-started/install.mdx");
  const selfHosting = read("docs/remote-server.md");
  assert.match(install, /standalone binary[^\n]*(?:includes|embeds)[^\n]*UI/iu);
  assert.match(install, /climier ui[^\n]*(?:source|checkout)/iu);
  assert.match(selfHosting, /standalone binary[^\n]*(?:includes|embeds)[^\n]*UI/iu);
  assert.match(selfHosting, /`uiRoot` setting is\s+optional/u);
});
