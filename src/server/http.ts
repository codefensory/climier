import fs from "node:fs/promises";

import { dispatchOperationRequest, validateOperationRequest } from "./http/operations.ts";
import { createOperationSource } from "../operation-source.ts";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.ts";
import { mutate } from "../kernel/mutate.ts";
import { createHttpReads } from "./http/reads.ts";
import { executeTransferRequest, validateTransferRequest } from "./http/transfers.ts";
import * as readModel from "../read-model/index.ts";
import { ledgerFile } from "../storage/ledger.ts";
import { readState, stateFile } from "../storage/state.ts";
import { initState } from "../kernel/state-operations.ts";
import { withAuthorizedProject } from "./auth/project-scope.ts";
import { createLoginRateLimiter, loginClientAddress } from "./auth/login-rate-limiter.ts";
import { createHttpCodec } from "./http/codec.ts";
import { createStaticHandler } from "./http/static.ts";
import { createUiApi } from "./http/ui-api.ts";
import { createUiEvents } from "./http/ui-events.ts";

const PROTOCOL_VERSION = "1";
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
const reads = createHttpReads({
  httpError,
  routing: { decodeURIComponent },
  query: { searchParams: (url) => url.searchParams },
  deps: readModel,
  clock: Date.now,
});

function validateServerDependencies({ catalog, openProject, getOperationSource, authStore }) {
  if (!catalog || typeof catalog.resolveProject !== "function"
      || typeof catalog.provisionProject !== "function" || typeof catalog.listProjects !== "function") {
    throw new TypeError("server http: catalog with resolveProject, provisionProject, and listProjects is required");
  }
  if (typeof openProject !== "function") {
    throw new TypeError("server http: openProject must be a function");
  }
  if (typeof getOperationSource !== "function") {
    throw new TypeError("server http: operation source builder is required");
  }
  if (!authStore || typeof authStore.verifyBearer !== "function" || typeof authStore.login !== "function") {
    throw new TypeError("server http: authStore with login and verifyBearer is required");
  }
}

async function authorizeUiRequest(request, authStore) {
  const authorization = request?.headers?.authorization;
  if (typeof authorization !== "string") {
    throw httpError("AUTH_REQUIRED", "server auth: bearer token is required", undefined, 401);
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    throw httpError("AUTH_REQUIRED", "server auth: bearer token is required", undefined, 401);
  }
  if (!await authStore.verifyBearer(match[1])) {
    throw httpError("AUTH_INVALID", "server auth: bearer token is invalid", undefined, 401);
  }
}

async function listProjectSummary(project) {
  const snapshot = await readState(project.projectDir);
  if (!snapshot) {
    return {
      project_id: project.source_project_id,
      name: project.name ?? null,
      revision: 0,
      node_count: 0,
      updated_at: null,
    };
  }
  const stateInfo = await fs.stat(stateFile(project.projectDir));
  return {
    project_id: project.source_project_id,
    name: project.name ?? null,
    revision: Number.isInteger(snapshot.revision) ? snapshot.revision : 0,
    node_count: snapshot.nodes && typeof snapshot.nodes === "object" && !Array.isArray(snapshot.nodes)
      ? Object.keys(snapshot.nodes).length
      : 0,
    updated_at: stateInfo.mtime.toISOString(),
  };
}

async function listProjectSummaries(dependencies) {
  const projects = await dependencies.catalog.listProjects();
  return Promise.all(projects.map((project) => listProjectSummary(project)));
}

async function getUiProject(projectId, dependencies) {
  const projectDir = await dependencies.catalog.resolveProject(projectId);
  const project = await dependencies.openProject(projectDir, { projectId });
  if (!project || typeof project.projectDir !== "string") {
    throw httpError("PROJECT_OPEN_FAILED", "server http: project opener did not return a projectDir", undefined, 500);
  }
  return { ...project, id: projectId, name: project.name || projectId };
}

function createRemoteUiApi(dependencies) {
  return createUiApi({
    authorize: (request) => authorizeUiRequest(request, dependencies.authStore),
    getProject: (projectId) => getUiProject(projectId, dependencies),
    readSnapshot: ({ projectDir }) => readState(projectDir),
    clock: Date.now,
  });
}

function createRemoteUiEvents(dependencies) {
  return createUiEvents({
    authorize: (request) => authorizeUiRequest(request, dependencies.authStore),
    getProject: (projectId) => getUiProject(projectId, dependencies),
    readSnapshot: ({ projectDir }) => readState(projectDir),
    resolveLedger: ({ projectDir }) => ledgerFile(projectDir),
    protocolVersion: PROTOCOL_VERSION,
  });
}

function assertProtocol(request) {
  const version = request.headers["x-climier-protocol-version"];
  if (version !== PROTOCOL_VERSION) {
    throw httpError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `server http: protocol version '${version === undefined ? "missing" : version}' is not supported; expected '${PROTOCOL_VERSION}'`,
      { expected: PROTOCOL_VERSION, received: version === undefined ? null : version },
      426,
    );
  }
}

function resolveRoute(request, url) {
  if (url.pathname === "/v1/auth/login") {
    assertProtocol(request);
    if (request.method !== "POST") {
      throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
    }
    return { login: true };
  }
  if (url.pathname === "/v1/projects") {
    assertProtocol(request);
    if (request.method !== "GET") {
      throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
    }
    return { projects: true, route: "projects" };
  }
  if (!url.pathname.startsWith("/v1/")) {
    throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
  }
  assertProtocol(request);
  const route = parseProjectPath(url.pathname);
  if (!route) {
    throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
  }
  return route;
}

function validateInitBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("INVALID_REQUEST", "server http: init request must be a JSON object", { field: "body" }, 400);
  }
  for (const field of Object.keys(body)) {
    if (field === "force" || field === "reset") {
      throw httpError("REMOTE_UNSUPPORTED_OPERATION", `server http: init option '${field}' is not supported remotely`, { field }, 400);
    }
    throw httpError("INVALID_REQUEST", `server http: init field '${field}' is not allowed`, { field }, 400);
  }
}

function isOperationRoute(request, route) {
  return request.method === "POST" && route.route === "operations";
}

function isInitRoute(request, route) {
  return request.method === "POST" && route.route === "init";
}

function matchRequestRoute(request, route, uiApi, uiEvents) {
  const projectsRoute = route.projects === true;
  const operationRoute = isOperationRoute(request, route);
  const initRoute = isInitRoute(request, route);
  const transferRoute = request.method === "GET" && route.route === "transfer/export"
    ? "transfer/export"
    : request.method === "POST" && route.route === "transfer/import"
      ? "transfer/import"
      : null;
  const read = request.method === "GET" ? reads.matchReadRoute(route.route) : null;
  const events = request.method === "GET" ? uiEvents.matchRoute(route.route) : null;
  const ui = request.method === "GET" ? uiApi.matchRoute(route.route) : null;
  if (projectsRoute || read || events || ui || operationRoute || initRoute || transferRoute) {
    return { projectsRoute, operationRoute, initRoute, transferRoute, read, events, ui };
  }
  if (route.route.startsWith("transfer/") || route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
    throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
  }
  throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
}

async function readRequestInput(request, route, matched, uiApi) {
  let body = null;
  if (matched.operationRoute) {
    body = validateOperationRequest(await readJsonBody(request), { manifest: remoteV1Manifest, httpError });
  }
  if (matched.initRoute) {
    body = await readJsonBody(request);
    validateInitBody(body);
  }
  if (matched.transferRoute === "transfer/import") {
    body = validateTransferRequest(await readJsonBody(request), httpError);
  }
  const url = new URL(request.url || "/", "http://localhost");
  const query = matched.read
    ? reads.parseReadQuery(url, matched.read)
    : matched.ui
      ? uiApi.parseQuery(url, matched.ui)
      : null;
  return { body, query };
}

async function openAuthorizedProject(request, route, initRoute, dependencies) {
  const project = await withAuthorizedProject({
    authorization: request.headers.authorization,
    projectId: route.projectId,
    authStore: dependencies.authStore,
    catalog: dependencies.catalog,
    openProject: async (projectDir, metadata) => dependencies.openProject(projectDir, { ...metadata, create: initRoute }),
    provision: initRoute,
  });
  if (!project || typeof project.projectDir !== "string") {
    throw httpError("PROJECT_OPEN_FAILED", "server http: project opener did not return a projectDir", undefined, 500);
  }
  return project;
}

async function handleInit(projectDir) {
  try {
    const mutation = await initState({ projectDir, actor: "system" });
    return mutation.result;
  } catch (error) {
    if (typeof error?.message === "string" && error.message.startsWith("state.init: state file already exists at ")) {
      throw httpError("STATE_ALREADY_INITIALIZED", "server http: project state is already initialized", undefined, 409);
    }
    throw error;
  }
}

async function operationSource(dependencies) {
  return dependencies.getOperationSource();
}

async function sendRouteResult({ response, route, matched, body, query, project, dependencies, request }) {
  if (matched.projectsRoute) {
    await authorizeUiRequest(request, dependencies.authStore);
    send(response, 200, { projects: await listProjectSummaries(dependencies) });
    return;
  }
  if (matched.events) {
    await dependencies.uiEvents.handle({ response, request, projectId: route.projectId });
    return;
  }
  if (matched.ui) {
    if (matched.ui.kind === "snapshot") {
      const result = await dependencies.uiApi.readSnapshotResponse({
        request,
        projectId: route.projectId,
      });
      if (result.status === 304) {
        response.writeHead(304, {
          ...result.headers,
          "content-length": "0",
          "x-climier-protocol-version": PROTOCOL_VERSION,
        });
        response.end();
      } else {
        response.writeHead(result.status, {
          ...result.headers,
          "x-climier-protocol-version": PROTOCOL_VERSION,
        });
        response.end(result.body);
      }
      return;
    }
    const result = await dependencies.uiApi.read({
      request,
      projectId: route.projectId,
      route: matched.ui,
      query,
    });
    send(response, 200, { ok: true, result });
    return;
  }
  if (matched.initRoute) {
    const result = await handleInit(project.projectDir);
    send(response, 200, { ok: true, result });
    return;
  }
  if (matched.operationRoute) {
    const result = await dispatchOperationRequest({
      projectDir: project.projectDir,
      body,
      source: await operationSource(dependencies),
      manifest: remoteV1Manifest,
    });
    send(response, 200, { ok: true, result });
    return;
  }
  if (matched.transferRoute) {
    const installed = await executeTransferRequest({
      projectDir: project.projectDir,
      route: matched.transferRoute,
      body,
      httpError,
    });
    const result = matched.transferRoute === "transfer/export" ? installed : { revision: installed.revision };
    send(response, 200, { ok: true, result });
    return;
  }
  const snapshot = await readState(project.projectDir);
  if (!snapshot) {
    throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
  }
  send(response, 200, { ok: true, result: reads.projectReadResult({ snapshot, route: matched.read, query }) });
}

async function handleLogin(request, response, dependencies) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.password !== "string" || Object.keys(body).some((key) => key !== "password")) {
    throw httpError("INVALID_REQUEST", "server http: login request requires only password", { field: "password" }, 400);
  }
  const clientAddress = loginClientAddress(request);
  dependencies.loginRateLimiter.assertAllowed(clientAddress);
  try {
    const token = await dependencies.authStore.login(body.password);
    dependencies.loginRateLimiter.recordSuccess(clientAddress);
    send(response, 200, { ok: true, token, token_type: "Bearer", expires_in_days: 30 });
  } catch (error) {
    if (error.code === "AUTH_INVALID_PASSWORD") {
      dependencies.loginRateLimiter.recordFailure(clientAddress);
      throw httpError("AUTH_INVALID", "server http: password is invalid", undefined, 401);
    }
    throw error;
  }
}

async function handleRequest(request, response, dependencies) {
  const url = new URL(request.url || "/", "http://localhost");
  const route = resolveRoute(request, url);
  if (route.login) {
    await handleLogin(request, response, dependencies);
    return;
  }
  const matched = matchRequestRoute(request, route, dependencies.uiApi, dependencies.uiEvents);
  const { body, query } = await readRequestInput(request, route, matched, dependencies.uiApi);
  const project = matched.projectsRoute || matched.ui || matched.events
    ? null
    : await openAuthorizedProject(request, route, matched.initRoute, dependencies);
  await sendRouteResult({ response, route, matched, body, query, project, dependencies, request });
}

function sendRequestError(response, error) {
  if (!response.headersSent) {
    send(response, errorStatus(error), jsonError(error));
  } else {
    response.destroy(error);
  }
}

function bunServerRuntime() {
  const bun = globalThis.Bun;
  if (!bun || typeof bun.serve !== "function") {
    throw new Error("server http: Bun.serve is required");
  }
  return bun;
}

function createBunRequest(request, server) {
  const listeners = new Map();
  const headers = Object.fromEntries(request.headers.entries());
  const rawUrl = request.url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/iu, "") || "/";
  const adapted = {
    method: request.method,
    url: rawUrl,
    headers,
    socket: { remoteAddress: server.requestIP(request)?.address ?? "127.0.0.1" },
    once(event, listener) {
      const wrapped = (...args) => {
        const callbacks = listeners.get(event);
        callbacks?.delete(wrapped);
        listener(...args);
      };
      const callbacks = listeners.get(event) || new Set();
      callbacks.add(wrapped);
      listeners.set(event, callbacks);
      return adapted;
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) || [])]) listener(...args);
    },
    async *[Symbol.asyncIterator]() {
      if (!request.body) return;
      const reader = request.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield Buffer.from(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  request.signal.addEventListener("abort", () => adapted.emit("aborted"), { once: true });
  return adapted;
}

function createBunResponse() {
  const listeners = new Map();
  const queued = [];
  const written = [];
  let controller;
  let status = 200;
  let headers = {};
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;
  const stream = new ReadableStream({
    start(nextController) {
      controller = nextController;
      for (const chunk of queued.splice(0)) controller.enqueue(chunk);
      if (writableEnded) controller.close();
    },
  });

  const emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) || [])]) listener(...args);
  };
  const response = {
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    get destroyed() { return destroyed; },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = Object.fromEntries(Object.entries(nextHeaders).map(([key, value]) => [key, String(value)]));
      headersSent = true;
      return response;
    },
    flushHeaders() {
      headersSent = true;
      return response;
    },
    write(data) {
      if (destroyed || writableEnded) return false;
      headersSent = true;
      const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      written.push(chunk);
      if (controller) controller.enqueue(chunk);
      else queued.push(chunk);
      return true;
    },
    end(data) {
      if (writableEnded) return response;
      if (data !== undefined) response.write(data);
      writableEnded = true;
      if (controller) controller.close();
      emit("close");
      return response;
    },
    destroy(error) {
      if (destroyed) return response;
      destroyed = true;
      if (controller) controller.error(error);
      emit("error", error);
      emit("close");
      return response;
    },
    once(event, listener) {
      const wrapped = (...args) => {
        const callbacks = listeners.get(event);
        callbacks?.delete(wrapped);
        listener(...args);
      };
      const callbacks = listeners.get(event) || new Set();
      callbacks.add(wrapped);
      listeners.set(event, callbacks);
      return response;
    },
    toResponse() {
      if (writableEnded) {
        return new Response(Buffer.concat(written), { status, headers });
      }
      return new Response(stream, { status, headers });
    },
  };
  return response;
}

export function createRemoteApiServer({
  catalog,
  authStore,
  openProject: openProjectDependency = async (projectDir) => ({ projectDir }),
  operationSource: operationSourceFactory,
  source,
  registry,
  mutate: mutateKernel = mutate,
  selectPolicy,
  authorizeAction,
  loginRateLimiter = createLoginRateLimiter(),
  uiRoot,
  indexFile = "index.html",
} = {}) {
  const getOperationSource = typeof operationSourceFactory === "function"
    ? operationSourceFactory
    : createOperationSource({
      source: operationSourceFactory || source,
      registry,
      mutate: mutateKernel,
      loadPolicy: selectPolicy,
      authorize: authorizeAction,
    });
  const dependencies = { catalog, authStore, openProject: openProjectDependency, getOperationSource, loginRateLimiter };
  validateServerDependencies(dependencies);
  dependencies.uiApi = createRemoteUiApi(dependencies);
  dependencies.uiEvents = createRemoteUiEvents(dependencies);
  const staticHandler = uiRoot === undefined ? null : createStaticHandler({ root: uiRoot, indexFile });
  let bunServer;
  let closePromise;
  const listeners = new Map();
  const emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) || [])]) listener(...args);
  };
  const fetch = async (request, bun) => {
    const adaptedRequest = createBunRequest(request, bun);
    const response = createBunResponse();
    request.signal.addEventListener("abort", () => response.destroy(), { once: true });
    try {
      if (staticHandler && await staticHandler(adaptedRequest, response)) {
        return response.toResponse();
      }
      await handleRequest(adaptedRequest, response, dependencies);
    } catch (error) {
      sendRequestError(response, error);
    }
    return response.toResponse();
  };
  const server = {
    get listening() { return bunServer !== undefined; },
    once(event, listener) {
      const wrapped = (...args) => {
        const callbacks = listeners.get(event);
        callbacks?.delete(wrapped);
        listener(...args);
      };
      const callbacks = listeners.get(event) || new Set();
      callbacks.add(wrapped);
      listeners.set(event, callbacks);
      return server;
    },
    on(event, listener) {
      const callbacks = listeners.get(event) || new Set();
      callbacks.add(listener);
      listeners.set(event, callbacks);
      return server;
    },
    listen(port, hostname, callback) {
      if (bunServer !== undefined) {
        const error = new Error("server http: server is already listening");
        emit("error", error);
        return server;
      }
      try {
        bunServer = bunServerRuntime().serve({ hostname, port, fetch });
        callback?.();
      } catch (error) {
        emit("error", error);
      }
      return server;
    },
    address() {
      if (!bunServer) return null;
      return {
        address: bunServer.hostname,
        family: bunServer.hostname?.includes(":") ? "IPv6" : "IPv4",
        port: bunServer.port,
      };
    },
    close(callback) {
      if (closePromise) {
        closePromise.then(() => callback?.(), (error) => callback?.(error));
        return server;
      }
      closePromise = (async () => {
        await dependencies.uiEvents.close();
        if (bunServer) {
          await bunServer.stop(true);
          bunServer = undefined;
        }
        emit("close");
      })();
      closePromise.then(() => callback?.(), (error) => {
        emit("error", error);
        callback?.(error);
      });
      return server;
    },
  };
  return server;
}

export { PROTOCOL_VERSION };
