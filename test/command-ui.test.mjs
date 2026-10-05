import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initState } from "../src/kernel/state-operations.mjs";
import uiCommand, { startLocalUiServer } from "../src/cli/commands/ui.mjs";

async function makeProject(t, projectId = "local-project") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-local-"));
  const home = path.join(root, "home");
  const uiRoot = path.join(root, "dist");
  await fs.mkdir(uiRoot, { recursive: true });
  await fs.writeFile(path.join(root, ".climier.json"), `${JSON.stringify({ version: 1, project_id: projectId })}\n`);
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>local UI</main>\n");
  await fs.mkdir(path.join(uiRoot, "assets"));
  await fs.writeFile(path.join(uiRoot, "assets", "app.js"), "console.log('local');\n");

  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  await initState({ projectDir: root });
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, uiRoot, projectId };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("climier ui serves the local SPA and UI projections without Express or bearer auth", async (t) => {
  const { root, uiRoot, projectId } = await makeProject(t);
  const started = await startLocalUiServer({ projectDir: root, uiRoot, port: 0 });
  t.after(() => closeServer(started.server));

  const entry = await fetch(`${started.url}/`);
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await entry.text(), "<!doctype html><main>local UI</main>\n");

  const health = await fetch(`${started.url}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const snapshot = await fetch(`${started.url}/v1/projects/${projectId}/ui/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("x-climier-protocol-version"), "1");
  const body = await snapshot.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.result.project, {
    id: projectId,
    name: projectId,
    revision: 1,
    generated_at: body.result.project.generated_at,
  });
  assert.deepEqual(body.result.nodes, {});
});

test("climier ui exposes the hosted read contract locally: catalog, login, ETag and SSE", async (t) => {
  const { root, uiRoot, projectId } = await makeProject(t, "contract-project");
  const started = await startLocalUiServer({ projectDir: root, uiRoot, port: 0 });
  t.after(() => closeServer(started.server));

  const catalog = await fetch(`${started.url}/v1/projects`);
  assert.equal(catalog.status, 200);
  const projects = (await catalog.json()).projects;
  assert.deepEqual(projects.map((project) => project.project_id), [projectId]);
  assert.equal(projects[0].revision, 1);
  assert.equal(projects[0].node_count, 0);

  const login = await fetch(`${started.url}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "anything" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.ok, true);
  assert.equal(session.token_type, "Bearer");

  const snapshot = await fetch(`${started.url}/v1/projects/${projectId}/ui/snapshot`);
  assert.equal(snapshot.headers.get("etag"), '"1"');
  const cached = await fetch(`${started.url}/v1/projects/${projectId}/ui/snapshot`, {
    headers: { "if-none-match": '"1"' },
  });
  assert.equal(cached.status, 304);

  const controller = new AbortController();
  const events = await fetch(`${started.url}/v1/projects/${projectId}/ui/events`, { signal: controller.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  controller.abort();
});

test("uiCommand starts the stdlib local server and reports the loopback URL", async (t) => {
  const { root, uiRoot } = await makeProject(t, "command-project");
  const result = await uiCommand({ projectDir: root, flags: { open: false, port: 0 }, uiRoot });
  assert.match(result.ui.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.ui.project, root);
  assert.equal(result.ui.read_only, true);

  const response = await fetch(`${result.ui.url}/api/health`);
  assert.equal(response.status, 200);
  await closeServer(result.server);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
});

test("ui keeps corrupt-state errors before starting the local server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-state-"));
  const home = path.join(root, "home");
  await fs.writeFile(path.join(root, ".climier.json"), `${JSON.stringify({ version: 1, project_id: "ui-state-project" })}\n`);
  await fs.mkdir(path.join(home, "projects", "ui-state-project"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", "ui-state-project", "tasks.json"), "not-json\n");
  const oldHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  try {
    await assert.rejects(
      uiCommand({ projectDir: root, flags: { open: false } }),
      (error) => error.code === "CLIMIER_CORRUPT_STATE",
    );
  } finally {
    if (oldHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});
