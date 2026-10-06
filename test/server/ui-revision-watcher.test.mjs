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

async function writeLedger(file, revision) {
  const temporary = `${file}.tmp-${process.pid}-${revision}`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, fence_generation: 1, high_water_revision: revision }) + "\n");
  await fs.rename(temporary, file);
}

test("revision watcher polls the authoritative ledger after directory renames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-revision-watcher-"));
  const ledger = path.join(root, "revision-ledger.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(ledger, 3);

  const revisions = [];
  const watcher = createRevisionWatcher({ ledgerPath: ledger, pollIntervalMs: 10 });
  watcher.subscribe((revision) => revisions.push(revision));
  await watcher.start();

  await writeLedger(ledger, 4);
  await waitFor(() => revisions.includes(4));
  assert.deepEqual(revisions, [4]);

  await writeLedger(ledger, 5);
  await waitFor(() => revisions.includes(5));
  assert.deepEqual(revisions, [4, 5]);

  await watcher.close();
  await writeLedger(ledger, 6);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(revisions, [4, 5]);
});

test("revision watcher re-resolves a changed ledger directory and closes its handles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-revision-watcher-resolve-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  const firstLedger = path.join(first, "revision-ledger.json");
  const secondLedger = path.join(second, "revision-ledger.json");
  await writeLedger(firstLedger, 1);
  await writeLedger(secondLedger, 1);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let currentLedger = firstLedger;
  const watcher = createRevisionWatcher({
    resolveLedger: () => currentLedger,
    pollIntervalMs: 10,
  });
  const revisions = [];
  watcher.subscribe((revision) => revisions.push(revision));
  await watcher.start();
  currentLedger = secondLedger;
  await writeLedger(secondLedger, 2);
  await waitFor(() => revisions.includes(2));
  assert.deepEqual(revisions, [2]);
  await watcher.close();
  await watcher.close();
  assert.equal(watcher.closed, true);
});
