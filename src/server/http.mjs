import { createServer } from "node:http";

import { dispatchOperationRequest, validateOperationRequest } from "./http/operations.mjs";
import { createBuiltinOperationRegistry } from "../application/operations/builtins.mjs";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { createHttpReads } from "./http/reads.mjs";
import { executeTransferRequest, validateTransferRequest } from "./http/transfers.mjs";
import * as readModel from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
import { initState } from "../kernel/state-operations.mjs";
import { authorizeAction as authorizeServerAction, loadApplicablePolicy } from "../plugins/policy.mjs";
import { withAuthorizedProject } from "./auth/project-scope.mjs";
import { createLoginRateLimiter, loginClientAddress } from "./auth/login-rate-limiter.mjs";
import { createHttpCodec } from "./http/codec.mjs";
import { createStaticHandler } from "./http/static.mjs";
import { createUiApi } from "./http/ui-api.mjs";

const PROTOCOL_VERSION = "1";
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
const reads = createHttpReads({
  httpError,
  routing: { decodeURIComponent },
  query: { searchParams: (url) => url.searchParams },
  deps: readModel,
  clock: Date.now,
});

function validateServerDependencies({ catalog, openProject, registry, mutateKernel, authStore }) {
  if (!catalog || typeof catalog.resolveProject !== "function" || typeof catalog.provisionProject !== "function") {
    throw new TypeError("server http: catalog with resolveProject and provisionProject is required");
  }
  if (typeof openProject !== "function") {
    throw new TypeError("server http: openProject must be a function");
  }
  if (!registry || typeof registry.lookup !== "function") {
    throw new TypeError("server http: registry.lookup is required");
  }
  if (typeof mutateKernel !== "function") {
    throw new TypeError("server http: mutate must be a function");
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

function matchRequestRoute(request, route, uiApi) {
  const operationRoute = isOperationRoute(request, route);
  const initRoute = isInitRoute(request, route);
  const transferRoute = request.method === "GET" && route.route === "transfer/export"
    ? "transfer/export"
    : request.method === "POST" && route.route === "transfer/import"
      ? "transfer/import"
      : null;
  const read = request.method === "GET" ? reads.matchReadRoute(route.route) : null;
  const ui = request.method === "GET" ? uiApi.matchRoute(route.route) : null;
  if (read || ui || operationRoute || initRoute || transferRoute) {
    return { operationRoute, initRoute, transferRoute, read, ui };
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

function operationSource(dependencies) {
  return {
    registry: dependencies.registry,
    mutate: dependencies.mutateKernel,
    selectPolicy: dependencies.selectPolicy || loadApplicablePolicy,
    authorizeAction: dependencies.authorizeAction || authorizeServerAction,
  };
}

async function sendRouteResult({ response, route, matched, body, query, project, dependencies, request }) {
  if (matched.ui) {
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
      source: operationSource(dependencies),
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
  const matched = matchRequestRoute(request, route, dependencies.uiApi);
  const { body, query } = await readRequestInput(request, route, matched, dependencies.uiApi);
  const project = matched.ui ? null : await openAuthorizedProject(request, route, matched.initRoute, dependencies);
  await sendRouteResult({ response, route, matched, body, query, project, dependencies, request });
}

function sendRequestError(response, error) {
  if (!response.headersSent) {
    send(response, errorStatus(error), jsonError(error));
  } else {
    response.destroy(error);
  }
}

export function createRemoteApiServer({
  catalog,
  authStore,
  openProject: openProjectDependency = async (projectDir) => ({ projectDir }),
  registry = createBuiltinOperationRegistry(),
  mutate: mutateKernel = mutate,
  selectPolicy,
  authorizeAction,
  loginRateLimiter = createLoginRateLimiter(),
  uiRoot,
  indexFile = "index.html",
} = {}) {
  const dependencies = { catalog, authStore, openProject: openProjectDependency, registry, mutateKernel, selectPolicy, authorizeAction, loginRateLimiter };
  validateServerDependencies(dependencies);
  dependencies.uiApi = createRemoteUiApi(dependencies);
  const staticHandler = uiRoot === undefined ? null : createStaticHandler({ root: uiRoot, indexFile });
  return createServer(async (request, response) => {
    try {
      if (staticHandler && await staticHandler(request, response)) {
        return;
      }
      await handleRequest(request, response, dependencies);
    } catch (error) {
      sendRequestError(response, error);
    }
  });
}

export { PROTOCOL_VERSION };
