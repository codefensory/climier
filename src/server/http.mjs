import { createServer } from "node:http";

import { dispatchOperationRequest, validateOperationRequest } from "./http/operations.mjs";
import { createBuiltinOperationRegistry } from "../application/operations/builtins.mjs";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.mjs";
import { mutate } from "../kernel/mutate.mjs";
import {
  blockingForNode,
  derive,
  informingForNode,
  knowledgeForNode,
  projectSnapshot,
  projectSearchView,
  projectStatusView,
  projectContextView,
  projectInitiativesView,
  projectLogView,
  statusOf,
} from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
import { initState } from "../kernel/state-operations.mjs";
import { authorizeAction as authorizeServerAction, loadApplicablePolicy } from "../plugins/policy.mjs";
import { withAuthorizedProject } from "./auth/project-scope.mjs";
import { createHttpCodec } from "./http/codec.mjs";
import { executeTransferRequest, validateTransferRequest } from "./http/transfers.mjs";

const PROTOCOL_VERSION = "1";
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody, readRoute } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
function invalidQuery(message, details) {
  throw httpError("INVALID_QUERY", `server http: ${message}`, details, 400);
}

function parseReadQuery(url, route) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (!route.allowedQuery.includes(key)) invalidQuery(`query parameter '${key}' is not allowed for ${route.kind}`, { parameter: key });
    if (Object.hasOwn(query, key)) invalidQuery(`query parameter '${key}' must not be repeated`, { parameter: key });
    query[key] = value;
  }
  if (route.kind === "search") {
    if (route.query !== undefined && Object.hasOwn(query, "query")) invalidQuery("search query must not be repeated in the path and query string", { parameter: "query" });
    query.query = route.query ?? query.query ?? "";
  }
  if (Object.hasOwn(query, "all")) {
    if (query.all === "") query.all = true;
    else {
      if (query.all !== "true" && query.all !== "false") invalidQuery("query parameter 'all' must be true or false", { parameter: "all", value: query.all });
      query.all = query.all === "true";
    }
  }
  const parseNonNegativeInt = (name, { number = false } = {}) => {
    if (!Object.hasOwn(query, name)) return;
    const value = query[name];
    const parsed = number ? Number(value) : parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || (!number && Number.isNaN(parsed))) {
      invalidQuery(`query parameter '${name}' must be a non-negative ${number ? "number" : "integer"}`, { parameter: name, value });
    }
    query[name] = parsed;
  };
  if (route.kind === "status") {
    parseNonNegativeInt("stale-ms");
    parseNonNegativeInt("limit");
  } else if (route.kind === "context") {
    parseNonNegativeInt("staleMs", { number: true });
  } else if (route.kind === "history" || route.kind === "log") {
    parseNonNegativeInt("limit");
  }
  return query;
}

function statusProjection(snapshot, filters, now) {
  return projectStatusView({ snapshot, filters, now });
}

function contextProjection(snapshot, id, query, now) {
  const view = projectContextView({ snapshot, id, agent: query.as, staleMs: query.staleMs, now });
  if (!view) throw httpError("NODE_NOT_FOUND", `server http: node '${id}' was not found`, { id }, 404);
  return view;
}

function entryReferencesId(entry, id) {
  return !!entry && !!id && (entry.node === id || entry.task === id || entry.decision === id || entry.gotcha === id
    || (typeof entry.note === "string" && entry.note.split(/\\s+/).includes(id)));
}

function projectReadResult(snapshot, route, query, now) {
  const nodes = snapshot.nodes || {};
  if (route.kind === "status") return statusProjection(snapshot, query, now);
  if (route.kind === "context") return contextProjection(snapshot, route.id, query, now);
  if (route.kind === "show") {
    const node = nodes[route.id];
    if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
    return { type: node.subkind || node.kind, node: structuredClone(node) };
  }
  if (route.kind === "history") {
    let entries = (snapshot.log || []).filter((entry) => entryReferencesId(entry, route.id));
    if (query.limit > 0) entries = entries.slice(-query.limit);
    return { id: route.id, entries };
  }
  if (route.kind === "search") return projectSearchView({ snapshot, query: query.query, all: query.all === true });
  if (route.kind === "initiatives") return projectInitiativesView({ snapshot, all: query.all === true });
  if (route.kind === "log") return projectLogView({ snapshot, filters: query });
  if (route.kind === "state") return projectSnapshot({ snapshot });
  const node = nodes[route.id];
  if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
  return { node: structuredClone(node), derived_status: statusOf({ snapshot, id: route.id }), blocking: blockingForNode({ snapshot, id: route.id }), knowledge: knowledgeForNode({ snapshot, id: route.id }), informing: informingForNode({ snapshot, id: route.id }) };
}

export function createRemoteApiServer({
  catalog,
  credentials = [],
  openProject = async (projectDir) => ({ projectDir }),
  registry = createBuiltinOperationRegistry(),
  mutate: mutateKernel = mutate,
  selectPolicy,
  authorizeAction,
} = {}) {
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw new TypeError("server http: catalog.resolveProject is required");
  }
  if (typeof openProject !== "function") throw new TypeError("server http: openProject must be a function");
  if (!registry || typeof registry.lookup !== "function") throw new TypeError("server http: registry.lookup is required");
  if (typeof mutateKernel !== "function") throw new TypeError("server http: mutate must be a function");

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
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
      if (!route) throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      const operationRoute = route.route === "operations" && request.method === "POST";
      const initRoute = route.route === "init" && request.method === "POST";
      const transferRoute = new Set(["transfer/export", "transfer/import"]).has(route.route) && request.method === "POST";
      const read = request.method === "GET" ? readRoute(route.route) : null;
      if (!read && !operationRoute && !initRoute && !transferRoute) {
        if (route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
          throw httpError("ROUTE_NOT_FOUND", "server http: generic file and snapshot routes are not available", undefined, 404);
        }
        throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      }
      let body = null;
      if (operationRoute) body = validateOperationRequest(await readJsonBody(request), { manifest: remoteV1Manifest, httpError });
      if (transferRoute) body = validateTransferRequest(await readJsonBody(request), route.route, httpError);
      if (initRoute) {
        body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw httpError("INVALID_REQUEST", "server http: init request must be a JSON object", { field: "body" }, 400);
        }
        for (const field of Object.keys(body)) {
          if (field === "force" || field === "reset") {
            const error = httpError("REMOTE_UNSUPPORTED_OPERATION", `server http: init option '${field}' is not supported remotely`, { field }, 400);
            throw error;
          }
          throw httpError("INVALID_REQUEST", `server http: init field '${field}' is not allowed`, { field }, 400);
        }
      }
      const query = read ? parseReadQuery(url, read) : null;
      const project = await withAuthorizedProject({
        authorization: request.headers.authorization,
        projectId: route.projectId,
        credentials,
        catalog,
        openProject,
        provision: initRoute,
      });
      if (!project || typeof project.projectDir !== "string") {
        throw httpError("PROJECT_OPEN_FAILED", "server http: project opener did not return a projectDir", undefined, 500);
      }

      if (transferRoute) {
        const result = await executeTransferRequest({ projectDir: project.projectDir, route: route.route, body });
        send(response, 200, { ok: true, result });
        return;
      }

      if (initRoute) {
        let result;
        try {
          const mutation = await initState({ projectDir: project.projectDir, actor: "system" });
          result = mutation.result;
        } catch (error) {
          if (typeof error?.message === "string" && error.message.startsWith("state.init: state file already exists at ")) {
            throw httpError("STATE_ALREADY_INITIALIZED", "server http: project state is already initialized", undefined, 409);
          }
          throw error;
        }
        send(response, 200, { ok: true, result });
        return;
      }

      if (operationRoute) {
        const source = {
          registry,
          mutate: mutateKernel,
          selectPolicy: selectPolicy || loadApplicablePolicy,
          authorizeAction: authorizeAction || authorizeServerAction,
        };
        const result = await dispatchOperationRequest({
          projectDir: project.projectDir,
          body,
          source,
          manifest: remoteV1Manifest,
        });
        send(response, 200, { ok: true, result });
        return;
      }

      const snapshot = await readState(project.projectDir);
      if (!snapshot) {
        throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
      }
      const now = Date.now();
      send(response, 200, { ok: true, result: projectReadResult(snapshot, read, query, now) });
    } catch (error) {
      if (!response.headersSent) send(response, errorStatus(error), jsonError(error));
      else response.destroy(error);
    }
  });
}

export { PROTOCOL_VERSION };
