import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createPackagedUiResolver } from "../../src/server/packaged-ui.ts";

test("packaged UI resolver selects filesystem distributions and memoizes the result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-packaged-ui-fs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.join(root, "src", "server", "packaged-ui.ts")).href;

  for (const distribution of ["npm", "source-link", "one-off"] as const) {
    const resolve = createPackagedUiResolver({ distribution, moduleUrl });
    const first = resolve();
    const second = resolve();
    assert.equal(first, second);
    assert.deepEqual(await first, { kind: "fs", root: path.join(root, "ui", "dist") });
  }
});

test("packaged UI resolver reads binary assets into a memoized in-memory map", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-packaged-ui-binary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.join(root, "climier")).href;
  const uiRoot = path.join(root, "ui", "dist");
  await fs.mkdir(path.join(uiRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<main>embedded</main>\n");
  await fs.writeFile(path.join(uiRoot, "assets", "app.js"), Buffer.from([0, 1, 255]));

  const resolve = createPackagedUiResolver({ distribution: "binary", moduleUrl });
  const first = resolve();
  assert.equal(first, resolve());
  const source = await first;
  assert.equal(source.kind, "embedded");
  if (source.kind !== "embedded") { return; }
  assert.deepEqual(source.files.get("index.html"), Buffer.from("<main>embedded</main>\n"));
  assert.deepEqual(source.files.get("assets/app.js"), Buffer.from([0, 1, 255]));
});

test("packaged UI resolver reads Bun's flattened directory asset layout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-packaged-ui-flattened-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.join(root, "climier")).href;
  await fs.mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.html"), "<main>flattened</main>\n");

  const source = await createPackagedUiResolver({ distribution: "binary", moduleUrl })();
  assert.equal(source.kind, "embedded");
  if (source.kind === "embedded") {
    assert.equal(source.files.get("index.html")?.toString(), "<main>flattened</main>\n");
  }
});
