import { createServer } from "node:http";

import { executeBatch, executeOperation } from "../application/operations/index.mjs";
import {
  createBuiltinOperationRegistry,
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "../application/operations/builtins.mjs";
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
  statusOf,
} from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
import { initState } from "../kernel/state-operations.mjs";
import { authorizeAction as authorizeServerAction, loadApplicablePolicy } from "../plugins/policy.mjs";
import { withAuthorizedProject } from "./auth/project-scope.mjs";

const PROTOCOL_VERSION = "1";
const MAX_BODY_BYTES = 1024 * 1024;
const OPERATION_IDS = new Set([
  ...PUBLIC_TASK_OPS,
  ...PUBLIC_GATE_OPS,
  ...PUBLIC_KNOWLEDGE_OPS,
  ...PUBLIC_CORE_OPS,
]);
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
const ALLOWED_INPUT_FIELDS = Object.freeze({
  "task.create": new Set(["id", "initiative", "title", "body", "acceptance", "blocked_by", "backlog", "domain", "definition", "refs", "tags", "meta", "derived_from"]),
  "task.update": new Set(["id", "changes", "if_revision", "if_revisions"]),
  "task.take": new Set(["id", "at"]),
  "task.release": new Set(["id"]),
  "task.reopen": new Set(["id", "reason", "if_revision"]),
  "task.cancel": new Set(["id", "reason", "if_revision"]),
  "task.submit": new Set(["id", "note", "submitted_at", "if_revision"]),
  "task.accept": new Set(["id", "accepted_at", "if_revision"]),
  "task.reject": new Set(["id", "reason", "if_revision"]),
  "gate.create": new Set(["id", "initiative", "title", "body", "purpose", "supersedes", "blocked_by", "derived_from", "backlog", "domain", "definition", "acceptance", "tags", "refs", "meta"]),
  "gate.update": new Set(["id", "changes", "if_revision"]),
  "gate.resolve": new Set(["id", "choice", "rationale", "resolved_at", "if_revision", "if_revisions"]),
  "gate.reopen": new Set(["id", "reason", "if_revisions"]),
  "gate.cancel": new Set(["id", "reason", "if_revisions"]),
  "knowledge.create": new Set(["id", "initiative", "title", "body", "scope", "supersedes", "knowledge_type", "mitigation", "domain", "tags", "refs", "meta"]),
  "knowledge.update": new Set(["id", "changes", "if_revision"]),
  "knowledge.deprecate": new Set(["id", "reason"]),
  "edge.add": new Set(["from", "to", "type"]),
  "edge.remove": new Set(["from", "to", "type"]),
  "note.add": new Set(["id", "text", "if_revision"]),
  "initiative.create": new Set(["name", "desc"]),
});
const ALLOWED_TOP_LEVEL_FIELDS = new Set(["operation", "input", "actor"]);
const BATCH_TOP_LEVEL_FIELDS = new Set(["operations", "if_state_revision"]);
const BATCH_OPERATION_FIELDS = new Set(["op", "input"]);
const TRANSFER_PAYLOAD_FIELDS = new Set(["version", "revision", "nodes", "edges", "initiatives", "log"]);

function httpError(code, message, details, status) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  error.status = status;
  return error;
}

function errorStatus(error) {
  if (Number.isInteger(error && error.status)) return error.status;
  const code = error && error.code;
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return 401;
  if (code === "PROJECT_SCOPE_DENIED" || code === "POLICY_DENIED") return 403;
  if (code === "UNKNOWN_PROJECT") return 404;
  if (code === "OPERATION_NOT_FOUND") return 404;
  if (code === "INVALID_PROJECT_ID") return 400;
  if (code === "NODE_NOT_FOUND" || code === "INITIATIVE_NOT_FOUND") return 404;
  if (code === "ID_CONFLICT" || code === "REVISION_CONFLICT" || code === "STATE_REVISION_CONFLICT" || code === "STATE_ALREADY_INITIALIZED" || code === "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE" || code === "CLIMIER_TRANSFER_PLUGIN_DATA") return 409;
  if (code === "INVALID_NAME" || code === "MISSING_FIELD" || code === "INVALID_EDGE_TARGET" || code === "INVALID_EDGE_KIND" || code === "SELF_EDGE" || code === "DUPLICATE_EDGE" || code === "NOT_READY" || code === "INVALID_STATUS") return 422;
  if (code === "CLIMIER_INCOMPATIBLE_VERSION" || code === "STATE_V1_UNSUPPORTED") return 409;
  if (typeof code === "string" && (code.startsWith("MISSING_") || code.startsWith("INVALID_") || code.startsWith("SELF_") || code.startsWith("DUPLICATE_") || code.startsWith("NOT_READY"))) return 422;
  return 400;
}

function jsonError(error) {
  const code = error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  const message = error && typeof error.message === "string" ? error.message : "server http: request failed";
  const body = { ok: false, error: { code, message } };
  if (error && error.details !== undefined) body.error.details = error.details;
  return body;
}

function send(response, status, body, headers = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-climier-protocol-version": PROTOCOL_VERSION,
    ...headers,
  });
  response.end(data);
}

function parseProjectPath(pathname) {
  const match = /^\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  let projectId;
  try {
    projectId = decodeURIComponent(match[1]);
  } catch {
    throw httpError("INVALID_PROJECT_ID", "server http: project ID path segment is not valid URL encoding", undefined, 400);
  }
  return { projectId, route: match[2] || "" };
}

function validateInputFields(value, field = "input") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_FIELDS.has(key)) {
      throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
    }
    validateInputFields(child, `${field}.${key}`);
  }
}

async function readJsonBody(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().split(";")[0].trim().includes("application/json")) {
    throw httpError("UNSUPPORTED_MEDIA_TYPE", "server http: Content-Type must be application/json", undefined, 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError("REQUEST_TOO_LARGE", `server http: request body exceeds ${MAX_BODY_BYTES} bytes`, undefined, 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError("INVALID_JSON", "server http: request body must be valid JSON", undefined, 400);
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
  if (body.operation === "core.batch") {
    for (const field of Object.keys(body.input)) {
      if (!BATCH_TOP_LEVEL_FIELDS.has(field)) {
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
        if (!BATCH_OPERATION_FIELDS.has(key)) {
          throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
        }
      }
      if (typeof operation.op !== "string" || operation.op.length === 0 || !OPERATION_IDS.has(operation.op) || operation.op === "core.batch") {
        throw httpError("INVALID_REQUEST", `server http: ${field}.op must name an allowed built-in operation`, { field: `${field}.op` }, 400);
      }
      if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
        throw httpError("INVALID_REQUEST", `server http: ${field}.input must be an object`, { field: `${field}.input` }, 400);
      }
      const allowedOperationFields = ALLOWED_INPUT_FIELDS[operation.op];
      for (const key of Object.keys(operation.input)) {
        if (!allowedOperationFields.has(key)) {
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
  const allowedFields = ALLOWED_INPUT_FIELDS[body.operation];
  if (!allowedFields) {
    throw httpError("OPERATION_NOT_FOUND", `application.executeOperation: operation '${body.operation}' is not available in protocol v1`, { operation: body.operation }, 404);
  }
  for (const field of Object.keys(body.input)) {
    if (!allowedFields.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: input field '${field}' is not allowed for ${body.operation}`, { field: `input.${field}`, operation: body.operation }, 400);
    }
  }
  validateInputFields(body.input);
  return body;
}

function readRoute(route) {
  const definitions = [
    ["status", /^read\/status$/, "status", ["initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as"]],
    ["context", /^read\/context\/([^/]+)$/, "context", ["as", "staleMs"]],
    ["show", /^read\/show\/([^/]+)$/, "show", []],
    ["history", /^read\/history\/([^/]+)$/, "history", ["limit"]],
    ["search", /^read\/search(?:\/([^/]+))?$/, "search", ["query", "all"]],
    ["initiatives", /^read\/initiatives$/, "initiatives", ["all"]],
    ["log", /^read\/log$/, "log", ["limit", "action", "agent", "task", "decision"]],
    ["state", /^read\/state$/, "state", []],
    ["node", /^read\/nodes\/([^/]+)$/, "node", []],
  ];
  for (const [, pattern, kind, allowedQuery] of definitions) {
    const match = pattern.exec(route);
    if (!match) continue;
    if (match[1] === undefined) return { kind, allowedQuery };
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw httpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
    }
    if (kind === "search") return { kind, id, query: id, allowedQuery };
    return { kind, id, allowedQuery };
  }
  return null;
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

function readInitiatives(snapshot, query) {
  const usage = new Map();
  for (const node of Object.values(snapshot.nodes || {})) {
    const name = node && node.initiative;
    if (!name) continue;
    const cur = usage.get(name) || { tasks: 0, knowledge: 0, nodes: 0 };
    if (node.kind === "knowledge") cur.knowledge += 1; else cur.tasks += 1;
    cur.nodes += 1;
    usage.set(name, cur);
  }
  const registered = Object.keys(snapshot.initiatives || {}).map((name) => {
    const usageForInitiative = usage.get(name) || { tasks: 0, knowledge: 0, nodes: 0 };
    return { name, desc: snapshot.initiatives[name]?.desc || "", created_at: snapshot.initiatives[name]?.created_at || null, nodes: usageForInitiative.nodes, tasks: usageForInitiative.tasks, knowledge: usageForInitiative.knowledge };
  });
  const visible = query.all ? registered : registered.filter((item) => item.nodes > 0);
  visible.sort((left, right) => right.nodes - left.nodes || left.name.localeCompare(right.name));
  return { initiatives: visible, unregistered: { nodes: 0, values: [] }, all: !!query.all };
}

function readLog(snapshot, query) {
  let entries = snapshot.log || [];
  for (const key of ["action", "agent", "task", "decision"]) if (query[key]) entries = entries.filter((entry) => entry[key] === query[key]);
  if (query.limit) entries = entries.slice(-query.limit);
  return entries;
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
  if (route.kind === "initiatives") return readInitiatives(snapshot, query);
  if (route.kind === "log") return readLog(snapshot, query);
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
        const result = body.operation === "core.batch"
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
