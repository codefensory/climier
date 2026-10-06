import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { test } from "node:test";

import { ledgerFile } from "../../../src/storage/ledger.ts";
import { createUiEvents } from "../../../src/server/http/ui-events.ts";
import { authHeaders, withApi } from "./fixtures.mjs";

async function writeRevision(file, revision) {
  const ledger = JSON.parse(await fs.readFile(file, "utf8"));
  ledger.high_water_revision = revision;
  const temporary = `${file}.tmp-${process.pid}-${revision}`;
  await fs.writeFile(temporary, `${JSON.stringify(ledger)}\n`);
  await fs.rename(temporary, file);
}

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for SSE data");
}

test("UI events authenticate, send heartbeats, and emit only changed revisions", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    const response = await fetch(`${baseUrl}/v1/projects/project-a/ui/events`, {
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-climier-protocol-version"), "1");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ": heartbeat\n\n");

    const ledger = ledgerFile(projectDirs[0]);
    const revision = JSON.parse(await fs.readFile(ledger, "utf8")).high_water_revision;
    await writeRevision(ledger, revision + 1);
    let text = "";
    while (!text.includes("data: ")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert.equal(text, `data: ${JSON.stringify({ revision: revision + 1 })}\n\n`);

    await reader.cancel();
  });
});

test("UI events share a project watcher and close it after the last client", async () => {
  const watchers = [];
  const events = createUiEvents({
    heartbeatMs: 5,
    authorize() {},
    getProject() { return { projectDir: "/tmp/project" }; },
    readSnapshot() { return { revision: 1 }; },
    createWatcher() {
      const listeners = new Set();
      const watcher = {
        started: 0,
        closed: 0,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start() { watcher.started += 1; },
        close() { watcher.closed += 1; },
        emit(revision) { for (const listener of listeners) listener(revision); },
      };
      watchers.push(watcher);
      return watcher;
    },
  });

  function response() {
    const value = new EventEmitter();
    value.writes = [];
    value.writableEnded = false;
    value.destroyed = false;
    value.writeHead = (status, headers) => { value.status = status; value.headers = headers; };
    value.flushHeaders = () => {};
    value.write = (data) => { value.writes.push(data); return true; };
    value.end = () => { value.writableEnded = true; value.emit("close"); };
    return value;
  }

  const request1 = new EventEmitter();
  const request2 = new EventEmitter();
  const response1 = response();
  const response2 = response();
  await events.handle({ request: request1, response: response1, projectId: "project" });
  await events.handle({ request: request2, response: response2, projectId: "project" });
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].started, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(response1.writes.filter((value) => value === ": heartbeat\n\n").length >= 2);

  watchers[0].emit(2);
  assert.ok(response1.writes.includes('data: {"revision":2}\n\n'));
  assert.ok(response2.writes.includes('data: {"revision":2}\n\n'));
  response1.emit("close");
  assert.equal(watchers[0].closed, 0);
  response2.emit("close");
  await waitFor(() => watchers[0].closed === 1);
  await events.close();
});

test("UI events preserve auth and project errors before opening a stream", async () => {
  await withApi(async ({ baseUrl }) => {
    const unauthenticated = await fetch(`${baseUrl}/v1/projects/project-a/ui/events`, {
      headers: { "x-climier-protocol-version": "1" },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");
  });
});
