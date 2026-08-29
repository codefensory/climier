// Regression test: clicking a sidebar nav item must switch the route in
// place (no page reload needed). This is the only UI test that renders the
// full App into a real DOM (jsdom) and dispatches a real click, so it pins
// the end-to-end navigation contract that the SSR view tests cannot cover.
//
// Setup notes:
//   - UI_JSX_GENERATE=dom makes test/jsx-loader.mjs compile JSX for the
//     client (solid "dom" generator) instead of SSR, so solid-js/web's
//     `render()` works inside jsdom.
//   - fetch is mocked at the network edge; the store + views run unmodified.
//   - Each `node --test` file runs in its own process, so the env var and
//     the global DOM do not leak into the SSR view tests.

process.env.UI_JSX_GENERATE = "dom";

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

register(new URL("./jsx-loader.mjs", import.meta.url).href, import.meta.url);

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const { JSDOM } = UI_REQUIRE("jsdom");

const UI_DEPS_OK =
  UI_REQUIRE.resolve("jsdom") &&
  UI_REQUIRE.resolve("solid-js/web");
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Minimal snapshot fixture following the Fase 1 contract (same shape the
// server produces): project, summary with every key, arrays for tasks /
// gates / knowledge, alerts, and the auxiliary maps.
const SNAP = {
  project: { project_id: "demo", root: "/tmp/demo", initialized: true },
  summary: {
    ready: 1,
    in_progress: 0,
    blocked: 0,
    backlog: 0,
    placeholders: 0,
    stale: 0,
    open_gates: 0,
    open_decisions: 0,
    done: 0,
    archived: 0,
    canceled: 0,
    resolved_gates: 0,
    superseded: 0,
    active_knowledge: 0,
    total_nodes: 1,
  },
  tasks: [
    {
      id: "T-1",
      title: "First task",
      kind: "resolvable",
      subkind: "task",
      status: "open",
      derived_status: "ready",
      initiative: "ui",
      revision: 1,
    },
  ],
  gates: [],
  knowledge: [],
  alerts: [],
  last_activity: {},
  initiative_summary: [],
  recent_activity: [],
};

// Helper: poll until fn() is truthy or the timeout elapses. The store loads
// the snapshot asynchronously (fetch -> signal update), so assertions must
// wait for the nav to exist.
async function waitFor(fn, ms = 2000, step = 10) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, step));
  }
}

// Boot a fresh jsdom + App instance. Returns { dispose, dom }.
async function bootApp() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost:5173/" },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  // Mock the network edge. The store/views run unmodified.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/api/snapshot")) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(SNAP)) };
    }
    if (u.includes("/api/node/")) {
      const id = decodeURIComponent(u.split("/api/node/")[1].split("?")[0]);
      return {
        ok: true,
        json: async () => ({
          node: { id, title: "Detail", kind: "resolvable", subkind: "task", status: "open", revision: 1 },
          derived_status: "ready",
          blocking: [],
          dependents: [],
          history: [],
          refs: [],
          knowledge: [],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const { render } = await import(pathToFileURL(UI_REQUIRE.resolve("solid-js/web/dist/web.js")).href);
  const { default: App } = await import(new URL("../ui/src/App.jsx", import.meta.url).href);

  const root = document.getElementById("root");
  const dispose = render(() => App(), root);

  // Wait for the first snapshot to land: the route view (not just the
  // always-present sidebar nav) must be rendered.
  await waitFor(() => document.querySelector('[data-view="overview"]'));
  return { dispose, dom };
}

test("sidebar click switches the view without reload (regression)", { skip }, async () => {
  const { dispose, dom } = await bootApp();
  try {
    // Initial view is Overview and the global header mirrors the page title.
    assert.ok(document.querySelector('main[data-route="overview"]'), "starts on overview");
    assert.equal(
      document.querySelector(".ui-shell-topbar h1")?.textContent.trim(),
      "Overview",
      "global header shows the current page title",
    );

    // Click the Tasks nav item the same way a user would.
    const tasksLink = document.querySelector('[data-route="tasks"]');
    assert.ok(tasksLink, "tasks nav item exists");
    tasksLink.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );

    // The view must switch in place — no reload.
    assert.ok(
      document.querySelector('main[data-route="tasks"]'),
      "main route flips to tasks after the click",
    );
    assert.equal(
      document.querySelector(".ui-shell-topbar h1")?.textContent.trim(),
      "Tasks",
      "global header follows the routed page title",
    );
    const tasksView = document.querySelector('[data-view="tasks"]');
    assert.ok(tasksView, "RouteView renders the tasks view after the click");
    assert.equal(
      tasksView.querySelector("h1")?.textContent.trim(),
      "Tasks",
      "the routed component changes, not just the URL and wrapper metadata",
    );
    assert.equal(dom.window.location.hash, "#/tasks", "hash is written for deep-link/back");

    // And navigation keeps working (back to Overview).
    const overviewLink = document.querySelector('[data-route="overview"]');
    overviewLink.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    assert.ok(
      document.querySelector('[data-view="overview"]'),
      "navigating back to overview works",
    );
  } finally {
    dispose();
    dom.window.close();
  }
});
