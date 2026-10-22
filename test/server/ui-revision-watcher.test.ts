import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRevisionWatcher } from "../../src/server/ui/revision-watcher.ts";

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for revision watcher");
}

async function writeState(file, revision) {
  const temporary = `${file}.tmp-${process.pid}-${revision}`;
  await fs.writeFile(temporary, JSON.stringify({ revision }) + "\n");
  await fs.rename(temporary, file);
}

async function readRevision(file) {
  return JSON.parse(await fs.readFile(file, "utf8")).revision;
}

test("revision watcher polls the SQLite state revision after directory changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-revision-watcher-"));
  const state = path.join(root, "state.sqlite");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeState(state, 3);

  const watcher = createRevisionWatcher({ statePath: state, readRevision, pollIntervalMs: 10 });
  const revisions: number[] = [];
  watcher.subscribe((revision) => revisions.push(revision));
  await watcher.start();

  await writeState(state, 4);
  await waitFor(() => revisions.includes(4));
  assert.deepEqual(revisions, [4]);

  await writeState(state, 5);
  await waitFor(() => revisions.includes(5));
  assert.deepEqual(revisions, [4, 5]);

  await watcher.close();
  await writeState(state, 6);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(revisions, [4, 5]);
});

test("revision watcher re-resolves the SQLite state path and closes its handles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-revision-watcher-resolve-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  const firstState = path.join(first, "state.sqlite");
  const secondState = path.join(second, "state.sqlite");
  await writeState(firstState, 1);
  await writeState(secondState, 1);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let currentState = firstState;
  const watcher = createRevisionWatcher({
    resolveState: () => currentState,
    readRevision,
    pollIntervalMs: 10,
  });
  const revisions: number[] = [];
  watcher.subscribe((revision) => revisions.push(revision));
  await watcher.start();
  currentState = secondState;
  await writeState(secondState, 2);
  await waitFor(() => revisions.includes(2));
  assert.deepEqual(revisions, [2]);
  await watcher.close();
  await watcher.close();
  assert.equal(watcher.closed, true);
});
