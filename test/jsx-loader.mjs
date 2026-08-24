// Tiny Node ESM loader that transforms .jsx and .tsx files via babel on
// demand. Used by test/ui-detail.test.mjs (and any future view-level test)
// so we can import a view module without precompiling every dependency.
//
// Lives in test/ alongside the test that consumes it. Uses the UI
// subproject's local babel + babel-preset-solid so the runtime contract
// matches Vite's build output.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(here, "..", "ui");
const require = createRequire(path.join(UI_DIR, "package.json"));
const babel = require("@babel/core");
const preset = require.resolve("babel-preset-solid");

export async function resolve(specifier, context, nextResolve) {
  // Let node handle anything that isn't JSX/TSX.
  if (!specifier.endsWith(".jsx") && !specifier.endsWith(".tsx")) {
    return nextResolve(specifier, context);
  }
  const parentURL = context.parentURL || pathToFileURL(process.cwd() + "/").href;
  let resolved;
  try {
    resolved = await nextResolve(specifier, context);
  } catch (err) {
    // node can't resolve relative .jsx without an extension helper; do it
    // by hand and retry.
    const url = new URL(specifier, parentURL);
    resolved = { url: url.href, shortCircuit: true, format: "module" };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".jsx") && !url.endsWith(".tsx")) {
    return nextLoad(url, context);
  }
  const filePath = fileURLToPath(url);
  const source = await fs.readFile(filePath, "utf8");
  const out = await babel.transformAsync(source, {
    filename: filePath,
    sourceType: "module",
    presets: [[preset, { generate: "ssr", hydratable: false }]],
  });
  return {
    format: "module",
    source: out.code,
    shortCircuit: true,
  };
}
