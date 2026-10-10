import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initState } from "../src/kernel/state-operations.ts";
import { runCli } from "./cli-harness.ts";
import uiCommand, { startLocalUiServer } from "../src/cli/commands/ui.ts";

interface SnapshotBody {
  ok: boolean;
  result: { project: { id: string; name: string; revision: number; generated_at: string }; nodes: Record<string, unknown> };
}
type CatalogProject = { project_id: string; name: string; revision: number; node_count: number; updated_at?: string | null };
type CatalogBody = { projects: CatalogProject[] };
type LoginBody = { ok: boolean; token_type: string };
type ErrorBody = { error: { code: string } };

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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
  const body = await snapshot.json() as SnapshotBody;
  assert.equal(body.ok, true);
  assert.deepEqual(body.result.project, {
    id: projectId,
    name: path.basename(root),
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
  const projects = (await catalog.json() as CatalogBody).projects;
  assert.deepEqual(projects.map((project) => project.project_id), [projectId]);
  assert.equal(projects[0].revision, 1);
  assert.equal(projects[0].node_count, 0);

  const login = await fetch(`${started.url}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "anything" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json() as LoginBody;
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

test("climier ui catalog lists every local project, not only the launch project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-catalog-"));
  const home = path.join(root, "home");
  const uiRoot = path.join(root, "dist");
  await fs.mkdir(uiRoot, { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>local UI</main>\n");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  for (const [dir, id] of [[projectA, "proj-a"], [projectB, "proj-b"]]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".climier.json"), `${JSON.stringify({ version: 1, project_id: id })}\n`);
  }
  await fs.mkdir(path.join(home, "projects", "stray"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", "stray", "notes.txt"), "x");

  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  await initState({ projectDir: projectA });
  await initState({ projectDir: projectB });
  const registered = await runCli(["--project", projectB, "add-initiative", "demo", "--as", "e2e"]);
  assert.equal(registered.code, 0, registered.stdout);
  const created = await runCli([
    "--project", projectB, "add-task", "T-b", "--initiative", "demo",
    "--title", "Catalog", "--body", "b", "--acceptance", "b", "--blocked-by", "", "--as", "e2e",
  ]);
  assert.equal(created.code, 0, created.stdout);

  const started = await startLocalUiServer({ projectDir: projectA, uiRoot, port: 0 });
  t.after(() => closeServer(started.server));

  const catalog = await (await fetch(`${started.url}/v1/projects`)).json();
  const projects = Object.fromEntries((catalog as CatalogBody).projects.map((project) => [project.project_id, project]));
  assert.deepEqual(Object.keys(projects).toSorted(), ["proj-a", "proj-b"]);
  assert.equal(projects["proj-a"].name, "project-a", "discovery names the launch checkouts");
  assert.equal(projects["proj-b"].name, "project-b");
  assert.equal(projects["proj-a"].node_count, 0);
  assert.equal(projects["proj-b"].node_count, 1);

  const other = await (await fetch(`${started.url}/v1/projects/proj-b/ui/snapshot`)).json() as SnapshotBody;
  assert.deepEqual(Object.keys(other.result.nodes), ["T-b"]);
  const launching = await (await fetch(`${started.url}/v1/projects/proj-a/ui/snapshot`)).json() as SnapshotBody;
  assert.deepEqual(Object.keys(launching.result.nodes), []);

  const unknown = await fetch(`${started.url}/v1/projects/not-a-project/ui/snapshot`);
  assert.equal(unknown.status, 404);
});

test("climier ui keeps an unreadable project in the catalog and fails when it is opened", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-broken-"));
  const home = path.join(root, "home");
  const uiRoot = path.join(root, "dist");
  await fs.mkdir(uiRoot, { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>local UI</main>\n");
  const project = path.join(root, "project-a");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, ".climier.json"), `${JSON.stringify({ version: 1, project_id: "proj-a" })}\n`);
  await fs.mkdir(path.join(home, "projects", "legacy"), { recursive: true });
  await fs.writeFile(
    path.join(home, "projects", "legacy", "tasks.json"),
    `${JSON.stringify({ version: 3, nodes: {}, edges: [], initiatives: {}, log: [] })}\n`,
  );

  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  await initState({ projectDir: project });

  const started = await startLocalUiServer({ projectDir: project, uiRoot, port: 0 });
  t.after(() => closeServer(started.server));

  const catalog = await (await fetch(`${started.url}/v1/projects`)).json();
  const legacy = (catalog as CatalogBody).projects.find((entry) => entry.project_id === "legacy");
  assert.deepEqual(legacy!, {
    project_id: "legacy",
    name: "legacy",
    revision: 0,
    node_count: 0,
    updated_at: legacy!.updated_at,
  });

  const opened = await fetch(`${started.url}/v1/projects/legacy/ui/snapshot`);
  assert.equal(opened.status, 400);
  assert.equal((await opened.json() as ErrorBody).error.code, "CLIMIER_LEDGER_MISSING");
});

test("uiCommand starts the stdlib local server and reports the loopback URL", async (t) => {
  const { root, uiRoot } = await makeProject(t, "command-project");
  const result = await uiCommand({
    command: "ui",
    originalArgv: [],
    positional: [],
    projectDir: root,
    statePath: root,
    projectConfig: { version: 1, project_id: "command-project" },
    flags: { open: false, port: "0" },
    uiRoot,
  });
  assert.match(result.ui.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.ui.project, root);
  assert.equal(result.ui.read_only, true);

  const response = await fetch(`${result.ui.url}/api/health`);
  assert.equal(response.status, 200);
  await closeServer((result as typeof result & { server: import("node:http").Server }).server);
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
      uiCommand({
        command: "ui",
        originalArgv: [],
        positional: [],
        projectDir: root,
        statePath: root,
        projectConfig: { version: 1, project_id: "ui-state-project" },
        flags: { open: false },
      }),
      (error) => (error as { code?: string }).code === "CLIMIER_CORRUPT_STATE",
    );
  } finally {
    if (oldHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("climier ui names projects discovered under the launch workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-discovery-"));
  const home = path.join(root, "home");
  const uiRoot = path.join(root, "dist");
  await fs.mkdir(uiRoot, { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>local UI</main>\n");
  const workspace = path.join(root, "workspace");
  const alpha = path.join(workspace, "alpha-repo");
  const beta = path.join(workspace, "beta-repo");
  const worktree = path.join(workspace, "nested", "alpha-worktree");
  for (const [dir, id] of [[alpha, "proj-alpha"], [beta, "proj-beta"], [worktree, "proj-alpha"]]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".climier.json"), `${JSON.stringify({ version: 1, project_id: id })}\n`);
  }

  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  await initState({ projectDir: alpha });
  await initState({ projectDir: beta });

  const started = await startLocalUiServer({ projectDir: workspace, uiRoot, port: 0 });
  t.after(() => closeServer(started.server));

  const catalog = await (await fetch(`${started.url}/v1/projects`)).json() as CatalogBody;
  const byId = Object.fromEntries(catalog.projects.map((project) => [project.project_id, project.name]));
  assert.equal(byId["proj-alpha"], "alpha-repo", "the shallowest checkout wins over a nested worktree");
  assert.equal(byId["proj-beta"], "beta-repo");

  const snapshot = await (await fetch(`${started.url}/v1/projects/proj-alpha/ui/snapshot`)).json() as SnapshotBody;
  assert.equal(snapshot.result.project.name, "alpha-repo");
});
