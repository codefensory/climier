import { createServer } from "node:http";

import { dispatchOperationRequest, validateOperationRequest } from "./http/operations.mjs";
import { createBuiltinOperationRegistry } from "../application/operations/builtins.mjs";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { createHttpReads } from "./http/reads.mjs";
import * as readModel from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
import { initState } from "../kernel/state-operations.mjs";
import { authorizeAction as authorizeServerAction, loadApplicablePolicy } from "../plugins/policy.mjs";
import { withAuthorizedProject } from "./auth/project-scope.mjs";
import { createHttpCodec } from "./http/codec.mjs";
import { executeTransferRequest, validateTransferRequest } from "./http/transfers.mjs";

const PROTOCOL_VERSION = "1";
const WRITE_ROUTES = new Set(["operations", "init", "transfer/export", "transfer/import"]);
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
const reads = createHttpReads({
  httpError,
  routing: { decodeURIComponent },
  query: { searchParams: (url) => url.searchParams },
  deps: readModel,
  clock: Date.now,
});

function validateServerDependencies({ catalog, openProject, registry, mutateKernel }) {
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw new TypeError("server http: catalog.resolveProject is required");
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
}

function resolveRoute(request, url) {
  if (!url.pathname.startsWith("/v1/")) {
    throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
  }
  const version = request.headers["x-climier-protocol-version"];
  if (version !== PROTOCOL_VERSION) {
    throw httpError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `server http: protocol version '${version === undefined ? "missing" : version}' is not supported; expected '${PROTOCOL_VERSION}'`,
      { expected: PROTOCOL_VERSION, received: version === undefined ? null : version },
      426,
    );
  }
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

function isTransferRoute(request, route) {
  return request.method === "POST" && route.route.startsWith("transfer/") && WRITE_ROUTES.has(route.route);
}

function hasMatchedRoute({ read, operationRoute, initRoute, transferRoute }) {
  return Boolean(read) || operationRoute || initRoute || transferRoute;
}

function matchRequestRoute(request, route) {
  const operationRoute = isOperationRoute(request, route);
  const initRoute = isInitRoute(request, route);
  const transferRoute = isTransferRoute(request, route);
  const read = request.method === "GET" ? reads.matchReadRoute(route.route) : null;
  if (hasMatchedRoute({ read, operationRoute, initRoute, transferRoute })) {
    return { operationRoute, initRoute, transferRoute, read };
  }
  if (route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
    throw httpError("ROUTE_NOT_FOUND", "server http: generic file and snapshot routes are not available", undefined, 404);
  }
  throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
}

async function readRequestInput(request, route, matched) {
  let body = null;
  if (matched.operationRoute) {
    body = validateOperationRequest(await readJsonBody(request), { manifest: remoteV1Manifest, httpError });
  }
  if (matched.transferRoute) {
    body = validateTransferRequest(await readJsonBody(request), route.route, httpError);
  }
  if (matched.initRoute) {
    body = await readJsonBody(request);
    validateInitBody(body);
  }
  const query = matched.read ? reads.parseReadQuery(new URL(request.url || "/", "http://localhost"), matched.read) : null;
  return { body, query };
}

async function openAuthorizedProject(request, route, initRoute, dependencies) {
  const project = await withAuthorizedProject({
    authorization: request.headers.authorization,
    projectId: route.projectId,
    credentials: dependencies.credentials,
    catalog: dependencies.catalog,
    openProject: dependencies.openProject,
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

async function sendRouteResult({ response, route, matched, body, query, project, dependencies }) {
  if (matched.transferRoute) {
    const result = await executeTransferRequest({ projectDir: project.projectDir, route: route.route, body });
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
  const snapshot = await readState(project.projectDir);
  if (!snapshot) {
    throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
  }
  send(response, 200, { ok: true, result: reads.projectReadResult({ snapshot, route: matched.read, query }) });
}

async function handleRequest(request, response, dependencies) {
  const url = new URL(request.url || "/", "http://localhost");
  const route = resolveRoute(request, url);
  const matched = matchRequestRoute(request, route);
  const { body, query } = await readRequestInput(request, route, matched);
  const project = await openAuthorizedProject(request, route, matched.initRoute, dependencies);
  await sendRouteResult({ response, route, matched, body, query, project, dependencies });
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
  credentials = [],
  openProject: openProjectDependency = async (projectDir) => ({ projectDir }),
  registry = createBuiltinOperationRegistry(),
  mutate: mutateKernel = mutate,
  selectPolicy,
  authorizeAction,
} = {}) {
  const dependencies = { catalog, credentials, openProject: openProjectDependency, registry, mutateKernel, selectPolicy, authorizeAction };
  validateServerDependencies(dependencies);
  return createServer(async (request, response) => {
    try {
      await handleRequest(request, response, dependencies);
    } catch (error) {
      sendRequestError(response, error);
    }
  });
}

export { PROTOCOL_VERSION };
