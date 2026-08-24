// The UI server (ui/server/server.mjs) must reflect the live state file on
// every request: mutations made through the CLI (atomic tmp+rename writes)
// have to show up without restarting the server or reloading the page.
// Regression for the previous "state cached once at boot" behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { updateState } from "../src/state.mjs";
import {
  createTempProject,
  rmTempProject,
  writeState,
  exampleState,
  stateFilePath,
} from "./helpers.mjs";

const SERVER_FILE = path.resolve("ui/server/server.mjs");
const UI_DEPS_OK = fs.existsSync(path.resolve("ui/node_modules/express"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

const serverMod = await import(pathToFileURL(SERVER_FILE).href);

async function startServer(projectDir) {
  const started = await serverMod.start({ projectDir, port: 0, log: () => {} });
  const port = started.server.address().port;
  return { base: `http://127.0.0.1:${port}`, server: started.server };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `GET ${url} failed`);
  return r.json();
}

test("snapshot and node endpoints reflect state mutations without restart", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const before = await getJson(`${base}/api/snapshot`);
  assert.equal(before.project.initialized, true);
  assert.equal(before.nodes["F0.T1"].status, "open");
  const nodeBefore = await getJson(`${base}/api/node/F0.T1`);
  assert.equal(nodeBefore.node.status, "open");

  // Simulate a CLI mutation while the server is running (atomic write,
  // same path the real CLI uses: tmp file + rename).
  await updateState(dir, (s) => ({
    ...s,
    nodes: { ...s.nodes, "F0.T1": { ...s.nodes["F0.T1"], status: "done" } },
    log: [...s.log, { action: "resolve", node: "F0.T1", agent: "ui-live-test", ts: new Date().toISOString(), note: "ui live test" }],
  }));

  const after = await getJson(`${base}/api/snapshot`);
  assert.equal(after.nodes["F0.T1"].status, "done");
  assert.equal(after.summary.done, 1);
  assert.equal(after.recent_activity[0].node, "F0.T1");
  const nodeAfter = await getJson(`${base}/api/node/F0.T1`);
  assert.equal(nodeAfter.node.status, "done");
});

test("snapshot picks up a project initialized while the server runs", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  // No state file yet: the project starts uninitialized.
  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const before = await getJson(`${base}/api/snapshot`);
  assert.equal(before.project.initialized, false);

  await writeState(dir, exampleState());

  const after = await getJson(`${base}/api/snapshot`);
  assert.equal(after.project.initialized, true);
  assert.ok(after.nodes["F0.T1"]);
});

test("corrupt state mid-run serves last good snapshot with a state-read-error alert", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  // Corrupt the state file behind the running server's back.
  await fs.promises.writeFile(stateFilePath(dir), "{ not json", "utf8");

  const snap = await getJson(`${base}/api/snapshot`);
  // The UI stays alive on the last good state, with a visible alert.
  assert.equal(snap.project.initialized, true);
  assert.ok(snap.nodes["F0.T1"]);
  assert.ok(snap.alerts.some((a) => a.kind === "state-read-error"));
});
