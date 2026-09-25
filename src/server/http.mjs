import { createServer } from "node:http";

import { executeOperation } from "../application/operations/index.mjs";
import {
  createBuiltinOperationRegistry,
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "../application/operations/builtins.mjs";
import { mutate } from "../kernel/mutate.mjs";
import {
  blockingForNode,
  derive,
  informingForNode,
  knowledgeForNode,
  statusOf,
} from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
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
  "gate.create": new Set(["id", "initiative", "title", "body", "purpose", "supersedes", "backlog", "domain", "definition", "acceptance", "tags", "refs", "meta"]),
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
  if (code === "ID_CONFLICT" || code === "REVISION_CONFLICT" || code === "STATE_REVISION_CONFLICT") return 409;
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
  if (!OPERATION_IDS.has(body.operation)) {
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
  if (route === "read/status") return { kind: "status" };
  const match = /^read\/nodes\/([^/]+)$/.exec(route);
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw httpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
    }
    return { kind: "node", id };
  }
  return null;
}

function projectReadResult(snapshot, route) {
  if (route.kind === "status") {
    return {
      revision: snapshot.revision || 0,
      derived: derive({ snapshot }),
    };
  }
  const node = snapshot.nodes && snapshot.nodes[route.id];
  if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
  return {
    node: structuredClone(node),
    derived_status: statusOf({ snapshot, id: route.id }),
    blocking: blockingForNode({ snapshot, id: route.id }),
    knowledge: knowledgeForNode({ snapshot, id: route.id }),
    informing: informingForNode({ snapshot, id: route.id }),
  };
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
      const read = request.method === "GET" ? readRoute(route.route) : null;
      if (!read && !operationRoute) {
        if (route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
          throw httpError("ROUTE_NOT_FOUND", "server http: generic file and snapshot routes are not available", undefined, 404);
        }
        throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      }
      const body = operationRoute ? validateOperationRequest(await readJsonBody(request)) : null;
      const project = await withAuthorizedProject({
        authorization: request.headers.authorization,
        projectId: route.projectId,
        credentials,
        catalog,
        openProject,
      });
      if (!project || typeof project.projectDir !== "string") {
        throw httpError("PROJECT_OPEN_FAILED", "server http: project opener did not return a projectDir", undefined, 500);
      }

      if (operationRoute) {
        const result = await executeOperation({
          projectDir: project.projectDir,
          actor: body.actor,
          operation: body.operation,
          input: body.input,
          source: {
            registry,
            mutate: mutateKernel,
            selectPolicy: selectPolicy || loadApplicablePolicy,
            authorizeAction: authorizeAction || authorizeServerAction,
          },
        });
        send(response, 200, { ok: true, result });
        return;
      }

      const snapshot = await readState(project.projectDir);
      if (!snapshot) {
        throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
      }
      send(response, 200, { ok: true, result: projectReadResult(snapshot, read) });
    } catch (error) {
      if (!response.headersSent) send(response, errorStatus(error), jsonError(error));
      else response.destroy(error);
    }
  });
}

export { PROTOCOL_VERSION };
