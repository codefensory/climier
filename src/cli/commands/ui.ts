import fsSync from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createHttpCodec } from "../../server/http/codec.ts";
import { createStaticHandler } from "../../server/http/static.ts";
import { createUiApi } from "../../server/http/ui-api.ts";
import { createUiEvents } from "../../server/http/ui-events.ts";
import { ledgerFileForProjectId, readStateByProjectId } from "../../storage/ledger.ts";
import { climierHome } from "../../storage/paths.ts";
import { listProjectIds, readState, stateFile, stateFileForProjectId } from "../../storage/state.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";

type UiOptions = { projectDir: string; uiRoot?: string; indexFile?: string; port?: number; clock?: () => number };

export const knownFlags = ["port", "open"];

const DEFAULT_PORT = 7373;
const LOOPBACK_HOST = "127.0.0.1";
const PROTOCOL_VERSION = "1";
const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "ui",
);
export const UI_ROOT = path.join(UI_DIR, "dist");
const { errorStatus, httpError, jsonError, parseProjectPath, send } = createHttpCodec({
  protocolVersion: PROTOCOL_VERSION,
});

function localProjectId(projectDir) {
  return path.basename(path.dirname(stateFile(projectDir)));
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

function localProjectRef(projectId) {
  return { id: projectId, name: projectId, projectDir: path.join(climierHome(), "projects", projectId) };
}

async function resolveLocalProject(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return null;
  }
  return (await listProjectIds()).includes(projectId) ? localProjectRef(projectId) : null;
}

function createLocalUiApi({ clock }) {
  return createUiApi({
    authorize: async () => {},
    getProject: (projectId) => resolveLocalProject(projectId),
    readSnapshot: (project) => readStateByProjectId((project as unknown as { id: string }).id),
    clock,
  });
}

function createLocalUiEvents() {
  return createUiEvents({
    authorize: async () => {},
    getProject: (projectId) => resolveLocalProject(projectId),
    readSnapshot: (project) => readStateByProjectId((project as unknown as { id: string }).id),
    resolveLedger: ({ projectId }: { projectId: string }) => ledgerFileForProjectId(projectId),
    protocolVersion: PROTOCOL_VERSION,
  });
}

// Same shape the hosted catalog returns. Unreadable states stay in the catalog with
// neutral counters so one bad project cannot blank the whole board; the snapshot
// request for that project surfaces the real error.
async function localProjectSummary(projectId) {
  let updatedAt: string | null = null;
  try {
    updatedAt = fsSync.statSync(stateFileForProjectId(projectId)).mtime.toISOString();
  } catch {
    // A ledger-only project has no state file yet.
  }
  let state: ReadModelSnapshot | null = null;
  try {
    state = await readStateByProjectId(projectId) as ReadModelSnapshot | null;
  } catch {
    // Surfaced when the node/snapshot route reads this project.
  }
  return {
    project_id: projectId,
    name: projectId,
    revision: state && Number.isInteger(state.revision) ? state.revision : 0,
    node_count: state && state.nodes && typeof state.nodes === "object" && !Array.isArray(state.nodes)
      ? Object.keys(state.nodes).length
      : 0,
    updated_at: updatedAt,
  };
}

async function listLocalProjectSummaries() {
  const ids = await listProjectIds();
  return Promise.all(ids.map((projectId) => localProjectSummary(projectId)));
}

async function handleHealth(request, response) {
  const pathname = requestPath(request);
  if (request.method !== "GET" || (pathname !== "/health" && pathname !== "/api/health")) {
    return false;
  }
  send(response, 200, { ok: true });
  return true;
}

async function handleLocalUiApi(request, response, { uiApi, uiEvents, projectId }) {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/v1/auth/login") {
    if (request.method !== "POST") {
      throw routeNotFound();
    }
    // Loopback-only adapter: the hosted contract is answered without credentials.
    send(response, 200, { ok: true, token: `local-${projectId}`, token_type: "Bearer", expires_in_days: 30 });
    return;
  }
  if (url.pathname === "/v1/projects") {
    if (request.method !== "GET") {
      throw routeNotFound();
    }
    send(response, 200, { projects: await listLocalProjectSummaries() });
    return;
  }
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
    const result = await uiApi.readSnapshotResponse({ request, projectId: parsed.projectId });
    response.writeHead(result.status, {
      ...result.headers,
      ...(result.status === 304 ? { "content-length": "0" } : {}),
      "x-climier-protocol-version": PROTOCOL_VERSION,
    });
    response.end(result.body ?? undefined);
    return;
  }
  const query = uiApi.parseQuery(url, route);
  const result = await uiApi.read({
    request,
    projectId: parsed.projectId,
    route,
    query,
  });
  send(response, 200, { ok: true, result });
}

export function createLocalUiServer({ projectDir, uiRoot = UI_ROOT, indexFile = "index.html", clock = Date.now }: UiOptions) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new TypeError("ui: projectDir is required");
  }
  const projectId = localProjectId(projectDir);
  const staticHandler = createStaticHandler({ root: uiRoot, indexFile });
  const uiApi = createLocalUiApi({ clock });
  const uiEvents = createLocalUiEvents();
  const dependencies = { uiApi, uiEvents, projectId };

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

export async function startLocalUiServer({ projectDir, uiRoot = UI_ROOT, indexFile = "index.html", port = DEFAULT_PORT, clock = Date.now }: UiOptions) {
  const server = createLocalUiServer({ projectDir, uiRoot, indexFile, clock });
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
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

export default async function uiCommand(ctx: CommandContext & { uiRoot?: string }) {
  const projectDir = ctx.projectDir;
  const open = ctx.flags.open !== "false" && ctx.flags.open !== false;
  const port = typeof ctx.flags.port === "string" ? parseInt(ctx.flags.port, 10) : Number.NaN;
  const finalPort = Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
  const uiRoot = ctx.uiRoot || UI_ROOT;

  await readState(projectDir);
  ensureBuild(uiRoot);

  let started;
  try {
    started = await startLocalUiServer({ projectDir, uiRoot, port: finalPort });
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code === "EADDRINUSE") {
      throw new Error(`ui: port ${finalPort} is already in use; pick another with --port <n>`, { cause: error });
    }
    throw error;
  }

  if (open) openBrowser(started.url);

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
