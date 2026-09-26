import { createServer } from "node:http";

import { executeBatch, executeOperation } from "../application/operations/index.mjs";
import { createBuiltinOperationRegistry } from "../application/operations/builtins.mjs";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { captureTransferSource, installTransferDestination } from "../kernel/transfer.mjs";
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

const PROTOCOL_VERSION = "1";
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody, readRoute } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
const OPERATIONS_BY_ID = new Map(remoteV1Manifest.operations.map((operation) => [operation.id, operation]));
const OPERATION_IDS = new Set(OPERATIONS_BY_ID.keys());
const BATCH_CAPABILITY = remoteV1Manifest.batch;
const FORBIDDEN_INPUT_FIELDS = new Set([
  "actor",
  "as",
  "_as",
  "pluginId",
  "plugin_id",
  "handler",
  "argv",
  "allow_unregistered_initiative",
  "if_state_revision",
]);
const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  "pluginId",
  "plugin_id",
  "handler",
  "argv",
  "source",
  "registry",
  "provider",
  "projectDir",
  "project_dir",
]);
const ALLOWED_TOP_LEVEL_FIELDS = new Set(["operation", "input", "actor"]);
const TRANSFER_PAYLOAD_FIELDS = new Set(["version", "revision", "nodes", "edges", "initiatives", "log"]);

function validateInputFields(value, field = "input") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_FIELDS.has(key)) {
      throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
    }
    validateInputFields(child, `${field}.${key}`);
  }
}

function validateTransferRequest(body, route) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("INVALID_REQUEST", "server http: transfer request must be a JSON object", { field: "body" }, 400);
  }
  const allowed = route === "transfer/export" ? new Set() : new Set(["payload", "actor", "overwrite"]);
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer field '${field}' is not allowed`, { field }, 400);
    }
  }
  if (route === "transfer/export") return body;
  if (typeof body.actor !== "string" || !body.actor.trim()) {
    throw httpError("INVALID_REQUEST", "server http: transfer actor is required", { field: "actor" }, 400);
  }
  if (!Object.hasOwn(body, "payload")) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload is required", { field: "payload" }, 400);
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    throw httpError("INVALID_REQUEST", "server http: transfer overwrite must be boolean", { field: "overwrite" }, 400);
  }
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload must be an object", { field: "payload" }, 400);
  }
  for (const field of Object.keys(payload)) {
    if (!TRANSFER_PAYLOAD_FIELDS.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer payload field '${field}' is not allowed`, { field: `payload.${field}` }, 400);
    }
  }
  for (const field of TRANSFER_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer payload field '${field}' is required`, { field: `payload.${field}` }, 400);
    }
  }
  if (payload.version !== 4 || !payload.nodes || typeof payload.nodes !== "object" || Array.isArray(payload.nodes)
      || !Array.isArray(payload.edges) || !payload.initiatives || typeof payload.initiatives !== "object"
      || Array.isArray(payload.initiatives) || !Array.isArray(payload.log)) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload has an invalid snapshot shape", { field: "payload" }, 400);
  }
  return body;
}

function validateOperationRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("INVALID_REQUEST", "server http: operation request must be a JSON object", { field: "body" }, 400);
  }
  for (const field of Object.keys(body)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.has(field) || !ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: request field '${field}' is not allowed`, { field }, 400);
    }
  }
  if (typeof body.operation !== "string" || body.operation.length === 0) {
    throw httpError("INVALID_REQUEST", "server http: operation is required", { field: "operation" }, 400);
  }
  if (!OPERATION_IDS.has(body.operation) && body.operation !== "core.batch") {
    const error = new Error(`application.executeOperation: operation '${body.operation}' is not registered`);
    error.code = "OPERATION_NOT_FOUND";
    error.details = { operation: body.operation };
    error.status = 404;
    throw error;
  }
  if (typeof body.actor !== "string" || body.actor.length === 0) {
    throw httpError("INVALID_REQUEST", "server http: actor is required", { field: "actor" }, 400);
  }
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    throw httpError("INVALID_REQUEST", "server http: input must be a JSON object", { field: "input" }, 400);
  }
  if (body.operation === BATCH_CAPABILITY.id) {
    for (const field of Object.keys(body.input)) {
      if (!BATCH_CAPABILITY.inputFields.includes(field)) {
        throw httpError("INVALID_REQUEST", `server http: input field '${field}' is not allowed for core.batch`, { field: `input.${field}`, operation: "core.batch" }, 400);
      }
    }
    const operations = body.input.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw httpError("INVALID_REQUEST", "server http: input.operations must be a non-empty array", { field: "input.operations" }, 400);
    }
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const field = `input.operations[${index}]`;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw httpError("INVALID_REQUEST", `server http: ${field} must be an object`, { field }, 400);
      }
      for (const key of Object.keys(operation)) {
        if (!BATCH_CAPABILITY.operationFields.includes(key)) {
          throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
        }
      }
      if (typeof operation.op !== "string" || operation.op.length === 0 || !BATCH_CAPABILITY.eligibleOperationIds.includes(operation.op) || operation.op === BATCH_CAPABILITY.id) {
        throw httpError("INVALID_REQUEST", `server http: ${field}.op must name an allowed built-in operation`, { field: `${field}.op` }, 400);
      }
      if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
        throw httpError("INVALID_REQUEST", `server http: ${field}.input must be an object`, { field: `${field}.input` }, 400);
      }
      const allowedOperationFields = OPERATIONS_BY_ID.get(operation.op)?.httpFields;
      for (const key of Object.keys(operation.input)) {
        if (!allowedOperationFields?.includes(key)) {
          throw httpError("INVALID_REQUEST", `server http: ${field}.input field '${key}' is not allowed for ${operation.op}`, { field: `${field}.input.${key}`, operation: operation.op }, 400);
        }
      }
      validateInputFields(operation.input, field + ".input");
    }
    if (Object.hasOwn(body.input, "if_state_revision") && (!Number.isSafeInteger(body.input.if_state_revision) || body.input.if_state_revision < 0)) {
      throw httpError("INVALID_REQUEST", "server http: input.if_state_revision must be a non-negative safe integer", { field: "input.if_state_revision" }, 400);
    }
    return body;
  }
  const allowedFields = OPERATIONS_BY_ID.get(body.operation)?.httpFields;
  if (!allowedFields) {
    throw httpError("OPERATION_NOT_FOUND", `application.executeOperation: operation '${body.operation}' is not available in protocol v1`, { operation: body.operation }, 404);
  }
  for (const field of Object.keys(body.input)) {
    if (!allowedFields.includes(field)) {
      throw httpError("INVALID_REQUEST", `server http: input field '${field}' is not allowed for ${body.operation}`, { field: `input.${field}`, operation: body.operation }, 400);
    }
  }
  validateInputFields(body.input);
  return body;
}

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
      if (operationRoute) body = validateOperationRequest(await readJsonBody(request));
      if (transferRoute) body = validateTransferRequest(await readJsonBody(request), route.route);
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
        const result = route.route === "transfer/export"
          ? await captureTransferSource({ sourceProjectDir: project.projectDir })
          : await installTransferDestination({
            destinationProjectDir: project.projectDir,
            payload: body.payload,
            actor: body.actor,
            direction: "push",
            overwrite: body.overwrite === true,
          });
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
        const result = body.operation === BATCH_CAPABILITY.id
          ? await executeBatch({
            projectDir: project.projectDir,
            actor: body.actor,
            input: body.input,
            source,
          })
          : await executeOperation({
            projectDir: project.projectDir,
            actor: body.actor,
            operation: body.operation,
            input: body.input,
            source,
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
