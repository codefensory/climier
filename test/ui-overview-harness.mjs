// Shared harness for the Overview.jsx contract tests (ui-overview.test.mjs
// and ui-overview-panels.test.mjs).
//
// The pure helpers (buildMetrics, groupAlertsByKind, readyTasks, ...) live at
// module scope in the view, so both files compile Overview.jsx the same way:
// babel + babel-preset-solid into a tmp module, with the view's relative JSX
// imports stubbed first. Only this module knows how that compile happens.

import path from "node:path";
import fs from "node:fs";
import { compileJsxView } from "./ui-view-compiler.mjs";

export const OVERVIEW_FILE = path.join(path.resolve("ui"), "src", "views", "Overview.jsx");

// The view's JSX imports are stubbed with inert values so the module compiles
// in a Node context: store hooks return empty signals, shell helpers return
// inert scalars, and components are no-op elements — except `kindFor`, which
// the view calls during render and therefore needs a real answer.
const JSX_STUBS = [
  ["../store.jsx", {
    useStore: `const useStore = () => ({ snapshot: () => null, select: () => {}, setRoute: () => {}, lastSuccessfulAt: () => null, refreshing: () => false, snapshotError: () => null });`,
  }],
  ["../shell.mjs", {
    projectDisplayName: `const projectDisplayName = () => "proj";`,
  }],
  ["../components.jsx", {
    kindFor: `const kindFor = (n) => { if (!n) return "task"; if (n.kind === "knowledge") return "knowledge"; if (n.subkind === "gate") return "gate"; return "task"; };`,
  }],
];

/** Read Overview.jsx source (for the file-scope and render-contract checks). */
export function readOverviewSource() {
  return fs.readFileSync(OVERVIEW_FILE, "utf8");
}

/** Compile Overview.jsx and import it. See ui-view-compiler.mjs. */
export function compileOverview(t) {
  return compileJsxView(OVERVIEW_FILE, { stubs: JSX_STUBS, t });
}
