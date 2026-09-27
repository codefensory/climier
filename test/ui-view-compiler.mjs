// Shared compile harness for the view-level UI tests.
//
// Node cannot load .jsx at all, so the view tests compile one view (or one
// components module) with babel + babel-preset-solid into a tmp module next
// to the original — that keeps module resolution pointed at the UI's own
// node_modules — and then import it. Babel and the preset are resolved
// through ui/package.json so the CLI package itself stays dependency-free.
//
// The tmp module is registered for cleanup with the test runner and again on
// process exit, so neither a failing assertion nor a crashed run leaves
// `.compiled.*.mjs` files in the working tree.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { stubJsxImports } from "./ui-jsx-stubs.mjs";

const UI_DIR = path.resolve("ui");
const uiRequire = createRequire(path.join(UI_DIR, "package.json"));
const babel = uiRequire("@babel/core");

/** True when the UI subproject's test dependencies are installed. */
export const uiDepsInstalled =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));

/** Skip reason for the UI tests, or false when they can run. */
export const uiSkip = uiDepsInstalled ? false : "ui dependencies not installed (run npm install in ui/)";

const tmpFiles = new Set();

process.on("exit", () => {
  for (const file of tmpFiles) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
});

/**
 * Compile a .jsx file and import the resulting module.
 *
 * @param {string} viewFile - absolute path of the .jsx file to compile.
 * @param {{ stubs?: Array<[string, Record<string, string>]>, t?: object }} [options]
 *   `stubs` rewrites the file's relative JSX imports before compiling (see
 *   ui-jsx-stubs.mjs); `t` is the test context, used to unlink the tmp file
 *   when the test ends.
 * @returns {Promise<{ module: object, cleanup: () => Promise<void> }>}
 */
export async function compileJsxView(viewFile, { stubs = [], t } = {}) {
  const rawSource = fs.readFileSync(viewFile, "utf8");
  const source = stubs.length > 0 ? stubJsxImports(rawSource, stubs) : rawSource;
  const out = await babel.transformAsync(source, {
    filename: viewFile,
    sourceType: "module",
    presets: [[uiRequire.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }]],
  });
  const base = path.basename(viewFile, ".jsx");
  const tmp = path.join(path.dirname(viewFile), `.${base}.compiled.${process.pid}.${Date.now()}.mjs`);
  fs.writeFileSync(tmp, out.code, "utf8");
  tmpFiles.add(tmp);
  const cleanup = () => {
    tmpFiles.delete(tmp);
    return fs.promises.unlink(tmp).catch(() => {});
  };
  if (t && typeof t.after === "function") {
    t.after(cleanup);
  }
  const module = await import(pathToFileURL(tmp).href);
  return { module, cleanup };
}
