import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createHttpCodec } from "../../server/http/codec.ts";
import { createStaticHandler } from "../../server/http/static.ts";
import { resolvePackagedUi, type PackagedUi } from "../../server/packaged-ui.ts";
import { createUiApi } from "../../server/http/ui-api.ts";
import { createUiEvents } from "../../server/http/ui-events.ts";
import { ledgerFileForProjectId, readStateByProjectId } from "../../storage/ledger.ts";
import { climierHome } from "../../storage/paths.ts";
import { listProjectIds, readProjectName, readState, stateFile, stateFileForProjectId } from "../../storage/state.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";

type UiOptions = { projectDir: string; uiRoot?: string; uiSource?: PackagedUi; indexFile?: string; port?: number; clock?: () => number; names?: WorkspaceNameIndex };
type WorkspaceNameIndex = Map<string, string>;

export const knownFlags = ["port", "open"];

const DEFAULT_PORT = 7373;
const LOOPBACK_HOST = "127.0.0.1";
const PROTOCOL_VERSION = "1";
const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "ui",
);
export const UI_ROOT = path.join(UI_DIR, "dist");
const WORKSPACE_DISCOVERY_MAX_DEPTH = 2;
const WORKSPACE_DISCOVERY_MAX_DIRECTORIES = 2000;
const WORKSPACE_DISCOVERY_SKIP = new Set(["node_modules", "dist", "build", "target", ".next", ".output", ".venv", ".cache", ".git"]);
const { errorStatus, httpError, jsonError, parseProjectPath, send } = createHttpCodec({
  protocolVersion: PROTOCOL_VERSION,
});

function localProjectId(projectDir) {
  return path.basename(path.dirname(stateFile(projectDir)));
}

async function readWorkspaceProjectId(directory) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(directory, ".climier.json"), "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.project_id === "string" && parsed.project_id.trim()
      ? parsed.project_id
      : null;
  } catch {
    return null;
  }
}

/**
 * `climier ui` is often launched from a workspace root that is not itself a
 * project (for example `~/dev`). Index the `.climier.json` files below it so
 * every local project can show the repository directory name instead of its
 * opaque storage id. Read-only: the index lives in memory for this server.
 * Shallowest wins so a shared project id resolves to the checkout, not a
 * worktree copy.
 */
async function readWorkspaceEntries(directory) {
  try {
    return await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function workspaceCandidate(entries, directory, depth) {
  if (!entries.some((entry) => entry.isFile() && entry.name === ".climier.json")) { return null; }
  const projectId = await readWorkspaceProjectId(directory);
  if (!projectId) { return null; }
  return { projectId, candidate: { depth, directory, name: path.basename(directory) } };
}

/** Shallowest wins, then the shorter path, then the alphabetically first name. */
function betterNameCandidate(incumbent, candidate) {
  if (!incumbent) { return true; }
  if (candidate.depth !== incumbent.depth) { return candidate.depth < incumbent.depth; }
  if (candidate.directory.length !== incumbent.directory.length) { return candidate.directory.length < incumbent.directory.length; }
  return candidate.name.localeCompare(incumbent.name) < 0;
}

function enqueueWorkspaceChildren(queue, entries, current) {
  if (current.depth >= WORKSPACE_DISCOVERY_MAX_DEPTH) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) { continue; }
    if (entry.name.startsWith(".") || WORKSPACE_DISCOVERY_SKIP.has(entry.name)) { continue; }
    queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
  }
}

async function discoverWorkspaceNames(rootDir) {
  const best = new Map();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: path.resolve(rootDir), depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < WORKSPACE_DISCOVERY_MAX_DIRECTORIES) {
    const current = queue.shift() as { directory: string; depth: number };
    visited += 1;
    const entries = await readWorkspaceEntries(current.directory);
    if (entries === null) { continue; }
    const found = await workspaceCandidate(entries, current.directory, current.depth);
    if (found && betterNameCandidate(best.get(found.projectId), found.candidate)) { best.set(found.projectId, found.candidate); }
    enqueueWorkspaceChildren(queue, entries, current);
  }
  return new Map<string, string>([...best].map(([projectId, entry]) => [projectId, entry.name]));
}

function requestPath(request) {
  return new URL(request.url || "/", "http://localhost").pathname;
}

function sendRequestError(response: import("node:http").ServerResponse, error: unknown) {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  send(response, errorStatus(error), jsonError(error));
}

function routeNotFound() {
  return httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
}

function localProjectRef(projectId, name) {
  return { id: projectId, name, projectDir: path.join(climierHome(), "projects", projectId) };
}

async function resolveLocalProject(projectId, names: WorkspaceNameIndex = new Map()) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return null;
  }
  if (!(await listProjectIds()).includes(projectId)) {
    return null;
  }
  return localProjectRef(projectId, (await readProjectName(projectId)) ?? names.get(projectId) ?? projectId);
}

function createLocalUiApi({ clock, names = new Map() }) {
  return createUiApi({
    authorize: async () => {},
    getProject: (projectId) => resolveLocalProject(projectId, names),
    readSnapshot: (project) => readStateByProjectId((project as unknown as { id: string }).id),
    clock,
  });
}

function createLocalUiEvents({ names = new Map() }) {
  return createUiEvents({
    authorize: async () => {},
    getProject: (projectId) => resolveLocalProject(projectId, names),
    readSnapshot: (project) => readStateByProjectId((project as unknown as { id: string }).id),
    resolveLedger: ({ projectId }: { projectId: string }) => ledgerFileForProjectId(projectId),
    protocolVersion: PROTOCOL_VERSION,
  });
}

// Same shape the hosted catalog returns. Unreadable states stay in the catalog with
// neutral counters so one bad project cannot blank the whole board; the snapshot
// request for that project surfaces the real error.
function localProjectUpdatedAt(projectId) {
  try {
    return fsSync.statSync(stateFileForProjectId(projectId)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function localProjectState(projectId) {
  try {
    return await readStateByProjectId(projectId) as ReadModelSnapshot | null;
  } catch {
    return null;
  }
}

function localProjectRevision(state: ReadModelSnapshot | null) {
  return state && Number.isInteger(state.revision) ? state.revision : 0;
}

function localProjectNodeCount(state: ReadModelSnapshot | null) {
  if (!state || !state.nodes || typeof state.nodes !== "object" || Array.isArray(state.nodes)) {
    return 0;
  }
  return Object.keys(state.nodes).length;
}

async function localProjectSummary(projectId, names: WorkspaceNameIndex = new Map()) {
  const state = await localProjectState(projectId);
  return {
    project_id: projectId,
    name: (await readProjectName(projectId)) ?? names.get(projectId) ?? projectId,
    revision: localProjectRevision(state),
    node_count: localProjectNodeCount(state),
    updated_at: localProjectUpdatedAt(projectId),
  };
}

async function listLocalProjectSummaries(names: WorkspaceNameIndex = new Map()) {
  const ids = await listProjectIds();
  return Promise.all(ids.map((projectId) => localProjectSummary(projectId, names)));
}

async function handleHealth(request, response) {
  const pathname = requestPath(request);
  if (request.method !== "GET" || (pathname !== "/health" && pathname !== "/api/health")) {
    return false;
  }
  send(response, 200, { ok: true });
  return true;
}

async function handleLocalLogin(request, response, projectId) {
  if (request.method !== "POST") {
    throw routeNotFound();
  }
  send(response, 200, { ok: true, token: `local-${projectId}`, token_type: "Bearer", expires_in_days: 30 });
}

async function handleLocalProjects(request, response, names: WorkspaceNameIndex = new Map()) {
  if (request.method !== "GET") {
    throw routeNotFound();
  }
  send(response, 200, { projects: await listLocalProjectSummaries(names) });
}

async function sendLocalSnapshot({ request, response, uiApi, projectId }) {
  const result = await uiApi.readSnapshotResponse({ request, projectId });
  response.writeHead(result.status, {
    ...result.headers,
    ...(result.status === 304 ? { "content-length": "0" } : {}),
    "x-climier-protocol-version": PROTOCOL_VERSION,
  });
  response.end(result.body ?? undefined);
}

async function handleLocalProject({ request, response, url, uiApi, uiEvents }) {
  if (request.method !== "GET") {
    throw routeNotFound();
  }
  const parsed = parseProjectPath(url.pathname);
  if (!parsed) {
    throw routeNotFound();
  }
  if (uiEvents.matchRoute(parsed.route)) {
    await uiEvents.handle({ request, response, projectId: parsed.projectId });
    return;
  }
  const route = uiApi.matchRoute(parsed.route);
  if (!route) {
    throw routeNotFound();
  }
  if (route.kind === "snapshot") {
    await sendLocalSnapshot({ request, response, uiApi, projectId: parsed.projectId });
    return;
  }
  const query = uiApi.parseQuery(url, route);
  const result = await uiApi.read({ request, projectId: parsed.projectId, route, query });
  send(response, 200, { ok: true, result });
}

async function handleLocalUiApi(request, response, { uiApi, uiEvents, projectId, names = new Map() }) {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/v1/auth/login") {
    await handleLocalLogin(request, response, projectId);
    return;
  }
  if (url.pathname === "/v1/projects") {
    await handleLocalProjects(request, response, names);
    return;
  }
  await handleLocalProject({ request, response, url, uiApi, uiEvents });
}

export function createLocalUiServer({ projectDir, uiRoot, uiSource, indexFile = "index.html", clock = Date.now, names = new Map() }: UiOptions) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new TypeError("ui: projectDir is required");
  }
  const projectId = localProjectId(projectDir);
  const staticHandler = uiSource
    ? createStaticHandler({ source: uiSource, indexFile })
    : createStaticHandler({ root: uiRoot ?? UI_ROOT, indexFile });
  const uiApi = createLocalUiApi({ clock, names });
  const uiEvents = createLocalUiEvents({ names });
  const dependencies = { uiApi, uiEvents, projectId, names };

  return createServer(async (request, response) => {
    try {
      if (await handleHealth(request, response)) {
        return;
      }
      if (await staticHandler(request, response)) {
        return;
      }
      await handleLocalUiApi(request, response, dependencies);
    } catch (caught) {
      sendRequestError(response, asCaughtError(caught));
    }
  });
}

export async function startLocalUiServer({ projectDir, uiRoot, uiSource, indexFile = "index.html", port = DEFAULT_PORT, clock = Date.now }: UiOptions) {
  const names = await discoverWorkspaceNames(projectDir);
  const resolvedUiSource = uiSource ?? (uiRoot === undefined ? await resolvePackagedUi() : { kind: "fs" as const, root: uiRoot });
  const server = createLocalUiServer({ projectDir, uiRoot, uiSource: resolvedUiSource, indexFile, clock, names });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("ui: local server did not expose a listening address");
  }
  return {
    server,
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    projectId: localProjectId(projectDir),
  };
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureBuild(uiRoot) {
  if (fsSync.existsSync(path.join(uiRoot, "index.html"))) {
    return;
  }
  const uiDir = path.dirname(uiRoot);
  const result = spawnSync(npmCommand(), ["run", "build"], { cwd: uiDir, stdio: ["ignore", 2, 2] });
  if (result.error || result.status !== 0) {
    throw new Error(`ui: failed to build the UI in ${uiDir} (run \`cd ${uiDir} && npm run build\` for details)`);
  }
}

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "darwin") { return ["open", [url]]; }
  if (process.platform === "win32") { return ["cmd", ["/c", "start", "", url]]; }
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

function uiPort(value) {
  const port = typeof value === "string" ? parseInt(value, 10) : Number.NaN;
  return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

async function startUiServer(options) {
  try {
    return await startLocalUiServer(options);
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code === "EADDRINUSE") {
      throw new Error(`ui: port ${options.port} is already in use; pick another with --port <n>`, { cause: caught });
    }
    throw error;
  }
}

export default async function uiCommand(ctx: CommandContext & { uiRoot?: string }) {
  const projectDir = ctx.projectDir;
  const open = ctx.flags.open !== "false" && ctx.flags.open !== false;
  const finalPort = uiPort(ctx.flags.port);

  await readState(projectDir);
  const uiSource: PackagedUi = ctx.uiRoot
    ? { kind: "fs", root: ctx.uiRoot }
    : await resolvePackagedUi();
  if (uiSource.kind === "fs") {
    ensureBuild(uiSource.root);
  }
  const started = await startUiServer({ projectDir, uiSource, port: finalPort });

  if (open) { openBrowser(started.url); }

  const result = {
    ui: {
      url: started.url,
      project: projectDir,
      state_file: stateFile(projectDir),
      read_only: true,
    },
  };
  Object.defineProperty(result, "server", { value: started.server, enumerable: false });
  return result;
}
