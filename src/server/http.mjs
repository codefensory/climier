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
import {
  blockingForNode,
  derive,
  informingForNode,
  knowledgeForNode,
  projectSnapshot,
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
const BATCH_TOP_LEVEL_FIELDS = new Set(["operations", "if_state_revision"]);
const BATCH_OPERATION_FIELDS = new Set(["op", "input"]);

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
  if (code === "ID_CONFLICT" || code === "REVISION_CONFLICT" || code === "STATE_REVISION_CONFLICT" || code === "STATE_ALREADY_INITIALIZED") return 409;
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

function claimBy(node) {
  if (node.claim && typeof node.claim === "object" && node.claim.by) return node.claim.by;
  return node.claimed_by || null;
}

function claimAtMs(node) {
  const at = (node.claim && node.claim.at) || node.claimed_at;
  if (at == null) return null;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function nodeSummary(node) {
  return {
    id: node.id,
    kind: node.kind,
    subkind: node.subkind,
    title: node.title || "",
    status: node.status || "open",
    initiative: node.initiative,
    domain: node.domain,
    claimed_by: claimBy(node),
  };
}

function statusProjection(snapshot, filters) {
  const nodes = snapshot.nodes || {};
  const derived = derive({ snapshot });
  const all = filters.all === true;
  const initiative = filters.initiative || null;
  const domain = filters.domain || null;
  const kind = filters.kind || null;
  const status = filters.status || null;
  const claimedBy = filters["claimed-by"] || null;
  const staleMs = filters["stale-ms"] === undefined ? 2 * 60 * 60 * 1000 : filters["stale-ms"];
  const limit = filters.limit === undefined ? null : filters.limit;
  const filterPool = (id) => {
    const node = nodes[id];
    if (!node) return false;
    if (initiative && node.initiative !== initiative) return false;
    if (domain && node.domain !== domain) return false;
    if (kind && node.kind !== kind) return false;
    if (status && (node.status || "open") !== status && statusOf({ snapshot, id }) !== status) return false;
    return true;
  };
  const ready = derived.ready.filter(filterPool);
  const blocked = derived.blocked.filter(filterPool);
  const backlog = derived.backlog.filter(filterPool);
  const selectTasks = (taskStatus) => Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === taskStatus)
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => !domain || node.domain === domain)
    .filter((node) => !kind || node.kind === kind)
    .map((node) => node.id);
  const submittedAll = selectTasks("submitted");
  const submitted = status ? (status === "submitted" ? submittedAll : []) : submittedAll;
  const inProgressAll = selectTasks("in_progress");
  let inProgress;
  if (status) inProgress = status === "in_progress" ? inProgressAll : [];
  else if (claimedBy) inProgress = inProgressAll.filter((id) => claimBy(nodes[id]) === claimedBy);
  else inProgress = inProgressAll;
  const openGatesAll = (derived.openGates || []).filter((id) => {
    const node = nodes[id];
    if (!node || (initiative && node.initiative !== initiative)) return false;
    if (kind && node.kind !== "resolvable") return false;
    return true;
  });
  const openGates = status ? openGatesAll.filter(() => status === "open") : openGatesAll;
  const knowledge = Object.values(nodes).filter((node) => node.kind === "knowledge").filter((node) =>
    (!initiative || node.initiative === initiative) && (!kind || node.kind === "knowledge"));
  const activeKnowledge = knowledge.filter((node) => (node.status || "active") === "active").length;
  const cap = (items) => limit === null ? items : items.slice(0, limit);
  const result = {
    summary: {
      ready: ready.length,
      in_progress: inProgress.length,
      submitted: submitted.length,
      blocked: blocked.length,
      backlog: backlog.length,
      open_gates: openGates.length,
      active_knowledge: activeKnowledge,
    },
    tasks: {
      ready: cap(ready).map((id) => nodeSummary(nodes[id])),
      in_progress: cap(inProgress).map((id) => nodeSummary(nodes[id])),
      submitted: cap(submitted).map((id) => nodeSummary(nodes[id])),
      blocked: cap(blocked).map((id) => ({
        ...nodeSummary(nodes[id]),
        unsatisfied_blockers: blockingForNode(snapshot, id).filter((blocker) => blocker.satisfied === false)
          .map((blocker) => blocker.node && blocker.node.id).filter(Boolean),
      })),
      backlog: cap(backlog).map((id) => nodeSummary(nodes[id])),
    },
    gates: { open: cap(openGates).map((id) => nodeSummary(nodes[id])) },
    knowledge_count: knowledge.length,
    alerts: [],
  };
  if (all) {
    result.knowledge = knowledge.map((node) => ({
      id: node.id,
      title: node.title || "",
      status: node.status || "active",
      initiative: node.initiative,
      scope: node.scope || {},
      knowledge_type: node.knowledge_type,
      deprecation_reason: node.deprecation_reason,
      deprecated_at: node.deprecated_at,
      deprecated_by: node.deprecated_by,
    }));
  }
  for (const node of Object.values(nodes)) {
    if (node.kind !== "resolvable" || node.subkind !== "task" || (node.status || "open") !== "in_progress") continue;
    if (initiative && node.initiative !== initiative) continue;
    const at = claimAtMs(node);
    const by = claimBy(node);
    const age = at === null ? null : Date.now() - at;
    if (age === null || !by || age <= staleMs || (claimedBy && by !== claimedBy)) continue;
    result.alerts.push({
      kind: "stale-claim",
      severity: "warning",
      task_id: node.id,
      claimed_by: by,
      age_ms: age,
      message: `${node.id} claimed by ${by} is stale (${Math.round(age / 60000)}m old)`,
    });
  }
  if (all) {
    const onInitiative = (node) => !initiative || node.initiative === initiative;
    const done = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "task" && node.status === "done" && onInitiative(node));
    const canceled = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "task" && node.status === "canceled" && onInitiative(node));
    const resolved = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "gate" && node.status === "resolved" && onInitiative(node));
    const superseded = Object.values(nodes).filter((node) => node.status === "superseded" && onInitiative(node));
    const deprecated = knowledge.filter((node) => node.status === "deprecated");
    result.done = { tasks: done.map(nodeSummary) };
    result.canceled = { tasks: canceled.map(nodeSummary) };
    result.resolved = { gates: resolved.map(nodeSummary) };
    result.superseded = { nodes: superseded.map(nodeSummary) };
    result.deprecated = { knowledge: deprecated.map((node) => ({
      id: node.id,
      title: node.title || "",
      deprecation_reason: node.deprecation_reason,
      deprecated_at: node.deprecated_at,
      deprecated_by: node.deprecated_by,
    })) };
  }
  return result;
}

function contextProjection(snapshot, id, query) {
  const node = snapshot.nodes && snapshot.nodes[id];
  if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${id}' was not found`, { id }, 404);
  const staleMs = query.staleMs === undefined ? 2 * 60 * 60 * 1000 : query.staleMs;
  const rawClaim = node.claim && typeof node.claim === "object" && node.claim.by
    ? { by: node.claim.by, at: node.claim.at ?? null }
    : node.claimed_by && node.claimed_at !== undefined ? { by: node.claimed_by, at: node.claimed_at ?? null } : null;
  const at = rawClaim && (typeof rawClaim.at === "number" ? rawClaim.at : typeof rawClaim.at === "string" ? Date.parse(rawClaim.at) : NaN);
  const claim = rawClaim ? { ...rawClaim, stale: Number.isFinite(at) && Date.now() - at > staleMs } : null;
  const blocking = blockingForNode(snapshot, id);
  const knowledge = knowledgeForNode(snapshot, id);
  const informing = informingForNode(snapshot, id);
  const alerts = [];
  if (claim && claim.stale) alerts.push({ kind: "STALE_CLAIM", node_id: id, claimed_by: claim.by, message: `${id} claimed by ${claim.by} is stale` });
  for (const blocker of blocking) if (blocker.node && blocker.node.status === "superseded") alerts.push({ kind: "SUPERSEDED_BLOCKER", node_id: id, blocker_id: blocker.node.id, superseded_by: blocker.node.superseded_by || null, message: `blocker ${blocker.node.id} is superseded${blocker.node.superseded_by ? ` by ${blocker.node.superseded_by}` : ""}` });
  for (const item of knowledge) if (item.status === "deprecated") alerts.push({ kind: "KNOWLEDGE_DEPRECATED_SOON", node_id: id, knowledge_id: item.id, message: `matching knowledge ${item.id} is deprecated` });
  const derivedStatus = statusOf({ snapshot, id });
  const identified = typeof query.as === "string" && query.as.length > 0;
  const allowed = [];
  if (node.kind === "resolvable" && node.subkind === "task") {
    if (derivedStatus === "ready") { if (identified) allowed.push("claim"); allowed.push("update", "add-note", "cancel"); }
    else if (derivedStatus === "in_progress") { if (identified) allowed.push("submit", "release", "add-note", "update"); else allowed.push("add-note"); }
    else if (derivedStatus === "submitted") { if (identified) allowed.push("accept", "reject"); allowed.push("add-note"); }
    else if (derivedStatus === "done") { allowed.push("add-note"); if (identified) allowed.push("reopen"); }
    else if (derivedStatus === "canceled") allowed.push("add-note", "update");
  } else if (node.kind === "resolvable" && node.subkind === "gate") {
    if (derivedStatus === "open") { allowed.push("resolve --choice <X> --rationale <Y>", "add-note", "supersede"); if (identified) allowed.push("cancel"); }
    else if (derivedStatus === "resolved") allowed.push("reopen", "supersede");
    else if (derivedStatus === "superseded") allowed.push("add-note");
  } else if (node.kind === "knowledge") {
    if ((node.status || "active") === "active") allowed.push("update", "add-note", "deprecate-knowledge");
    else if (node.status === "deprecated") allowed.push("update", "add-note");
  }
  return {
    node: structuredClone(node),
    derived_status: derivedStatus,
    can_claim: derivedStatus === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing,
    alerts,
    allowed_actions: allowed,
  };
}

function entryReferencesId(entry, id) {
  return !!entry && !!id && (entry.node === id || entry.task === id || entry.decision === id || entry.gotcha === id
    || (typeof entry.note === "string" && entry.note.split(/\\s+/).includes(id)));
}

function readSearch(snapshot, query) {
  const textQuery = String(query.query || "").toLowerCase();
  if (!textQuery) return { matches: [], count: 0 };
  const searchableFields = (node) => [["id", node.id], ["title", node.title], ["body", node.body], ["mitigation", node.mitigation], ["domain", node.domain], ["tags", node.tags], ["refs", (node.refs || []).map((ref) => ref && ref.target)], ["meta", node.meta]];
  const matches = Object.values(snapshot.nodes || {})
    .filter((node) => node.kind === "knowledge" && (query.all || (node.status || "active") === "active"))
    .map((node) => ({ node, matched_fields: searchableFields(node).filter(([, value]) => value != null && String(typeof value === "string" ? value : JSON.stringify(value)).toLowerCase().includes(textQuery)).map(([field]) => field) }))
    .filter(({ matched_fields }) => matched_fields.length)
    .sort((left, right) => left.node.id.localeCompare(right.node.id))
    .map(({ node, matched_fields }) => ({ id: node.id, kind: node.kind, title: node.title, initiative: node.initiative, domain: node.domain, status: node.status || "active", matched_fields, snippet: String(node.body || "").slice(0, 200) }));
  return { matches, count: matches.length };
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

function projectReadResult(snapshot, route, query) {
  const nodes = snapshot.nodes || {};
  if (route.kind === "status") return statusProjection(snapshot, query);
  if (route.kind === "context") return contextProjection(snapshot, route.id, query);
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
  if (route.kind === "search") return readSearch(snapshot, query);
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
      const read = request.method === "GET" ? readRoute(route.route) : null;
      if (!read && !operationRoute && !initRoute) {
        if (route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
          throw httpError("ROUTE_NOT_FOUND", "server http: generic file and snapshot routes are not available", undefined, 404);
        }
        throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      }
      let body = null;
      if (operationRoute) body = validateOperationRequest(await readJsonBody(request));
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
      send(response, 200, { ok: true, result: projectReadResult(snapshot, read, query) });
    } catch (error) {
      if (!response.headersSent) send(response, errorStatus(error), jsonError(error));
      else response.destroy(error);
    }
  });
}

export { PROTOCOL_VERSION };
