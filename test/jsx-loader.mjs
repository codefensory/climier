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

// Compile target: SSR (default, used by the renderToString view tests) or
// DOM (set UI_JSX_GENERATE=dom for client-side tests that render into
// jsdom and dispatch real events). Each `node --test` file runs in its own
// process, so the env var only affects the file that sets it.
const generate = process.env.UI_JSX_GENERATE === "dom" ? "dom" : "ssr";

export async function resolve(specifier, context, nextResolve) {
  // In DOM mode, `solid-js/web` must resolve to the client build; Node's
  // default condition set (node/import) picks the server build, which
  // throws "Client-only API called on the server side". Vite's browser
  // condition does the same redirection for the real app.
  if (generate === "dom") {
    if (specifier === "solid-js/web") {
      const web = require.resolve("solid-js/web/dist/web.js");
      return { url: pathToFileURL(web).href, shortCircuit: true, format: "module" };
    }
    // Same for the core package: the node condition maps to the server
    // build, where onMount/onCleanup are no-ops and client renders hang on
    // the initial skeleton. The browser build is dist/solid.js.
    if (specifier === "solid-js") {
      const solid = require.resolve("solid-js/dist/solid.js");
      return { url: pathToFileURL(solid).href, shortCircuit: true, format: "module" };
    }
  }
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
    presets: [[preset, { generate, hydratable: false }]],
  });
  return {
    format: "module",
    source: out.code,
    shortCircuit: true,
  };
}
