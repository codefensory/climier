// src/providers/knowledge/create.mjs — `knowledge.create` provider for
// the graph kernel.
//
// Implements the kernel provider contract from ADR-011 §1:
//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates domain rules; returns an immutable plan
//       carrying `{ target, policyAction, idempotent, node, supersedes? }`.
//   - `apply({ tx, plan, input, request, snapshot }) → { result }`
//       mutates ONLY the tx draft via `tx.createNode` / `tx.updateNode` /
//       `tx.addEdge`. The kernel owns revision assignment (see
//       `src/kernel/mutate.mjs`); the provider never seeds `revision`.
//
// Supports `knowledge.create` with optional `supersedes`.
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { throwV2 } from "../../contracts/errors.mjs";

const KNOWN_STATUSES = Object.freeze(["active", "deprecated"]); // deprecated cannot be set on create, kept for completeness
const SCOPE_KEYS = Object.freeze(["domains", "initiatives", "tags", "node_ids"]);

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInput(input) {
  if ((input === null || input === undefined) || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", "knowledge.create: input must be an object", { field: "input" });
  }
  return input;
}

function readScope(rawScope) {
  if ((rawScope === null || rawScope === undefined) || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return { domains: [], initiatives: [], tags: [], node_ids: [] };
  }
  const scope = {};
  for (const key of SCOPE_KEYS) {
    scope[key] = Array.isArray(rawScope[key]) ? rawScope[key].slice() : [];
  }
  return scope;
}

function scopeHasAnyValue(scope) {
  return SCOPE_KEYS.some((key) => Array.isArray(scope[key]) && scope[key].length > 0);
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.create: snapshot must be an object", { field: "snapshot" });
  }
  return snapshot;
}

function readInitiatives(snapshot) {
  return snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
}

function readNodes(snapshot) {
  return snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readRequiredText(input, field, flag) {
  const value = asString(input[field]).trim();
  if (!value) {
    throwV2("MISSING_FIELD", `knowledge.create: --${flag} is required`, { field });
  }
  return value;
}

function validateInitiative(snapshot, input) {
  const initiative = asString(input.initiative).trim();
  const allowUnregistered = input.allow_unregistered_initiative === true;
  if (!initiative && !allowUnregistered) {
    throwV2("MISSING_FIELD", "knowledge.create: --initiative is required", { field: "initiative" });
  }
  if (initiative && !Object.prototype.hasOwnProperty.call(readInitiatives(snapshot), initiative) && !allowUnregistered) {
    throwV2(
      "INITIATIVE_NOT_FOUND",
      `knowledge.create: initiative '${initiative}' is not registered`,
      { initiative },
    );
  }
  return { initiative, allowUnregistered };
}

function validateScope(input) {
  const scope = readScope(input.scope);
  if (!scopeHasAnyValue(scope)) {
    throwV2("MISSING_FIELD", "knowledge.create: at least one --scope-* value is required", { field: "scope" });
  }
  return scope;
}

function validateStatus(input) {
  const status = input.status === undefined ? "active" : asString(input.status);
  if (!KNOWN_STATUSES.includes(status)) {
    throwV2(
      "INVALID_PROVIDER_INPUT",
      `knowledge.create: status '${status}' is not allowed (allowed: ${KNOWN_STATUSES.join(", ")})`,
      { field: "status", value: status, allowed: KNOWN_STATUSES },
    );
  }
  return status;
}

function validateKnowledgeType(input) {
  const knowledgeType = input.knowledge_type === undefined ? "warning" : asString(input.knowledge_type);
  // knowledge_type is a free-form taxonomy string. Custom types are allowed.
  if (knowledgeType.length === 0) {
    throwV2(
      "MISSING_FIELD",
      "knowledge.create: --knowledge-type must be a non-empty string",
      { field: "knowledge_type" },
    );
  }
  return knowledgeType;
}

function validateId(input) {
  const id = input.id === undefined ? null : asNonEmptyString(input.id);
  if (input.id !== undefined && !id) {
    throwV2("MISSING_FIELD", "knowledge.create: id must be a non-empty string", { field: "id" });
  }
  return id;
}

function validateSupersedes(snapshot, id, input) {
  const supersedes = input.supersedes === undefined ? null : asNonEmptyString(input.supersedes);
  if (supersedes === null) {
    return supersedes;
  }
  const targetNode = readNodes(snapshot)[supersedes];
  if (!targetNode) {
    throwV2("NODE_NOT_FOUND", `knowledge.create: supersedes target '${supersedes}' does not exist`, {
      field: "supersedes",
      id: supersedes,
    });
  }
  if (targetNode.kind !== "knowledge") {
    throwV2("INVALID_PROVIDER_INPUT", `knowledge.create: supersedes target '${supersedes}' is not a knowledge node`, {
      field: "supersedes",
      id: supersedes,
      kind: targetNode.kind,
    });
  }
  if (id !== null && id === supersedes) {
    throwV2("INVALID_PROVIDER_INPUT", "knowledge.create: supersedes target cannot be the same as the new node id", {
      field: "supersedes",
      id,
    });
  }
  return supersedes;
}

function addOptionalText(node, input, field) {
  if (input[field] === undefined) {
    return;
  }
  const value = asString(input[field]);
  if (value.length > 0) {
    node[field] = value;
  }
}

function addOptionalLists(node, input) {
  if (Array.isArray(input.tags) && input.tags.length > 0) {
    node.tags = input.tags.slice();
  }
  if (Array.isArray(input.refs) && input.refs.length > 0) {
    node.refs = input.refs.map((ref) => (ref && typeof ref === "object") ? { ...ref } : ref);
  }
}

function addOptionalMeta(node, meta) {
  if (meta !== undefined && meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    node.meta = { ...meta };
  }
}

function addOptionalFields(node, input) {
  addOptionalText(node, input, "mitigation");
  addOptionalText(node, input, "domain");
  addOptionalLists(node, input);
  addOptionalMeta(node, input.meta);
}

function createNode(input, values) {
  const node = {
    id: values.id,
    kind: "knowledge",
    title: values.title,
    body: values.body,
    initiative: values.initiative,
    status: values.status,
    knowledge_type: values.knowledgeType,
    scope: values.scope,
  };
  if (values.allowUnregistered && !values.initiative) {
    // Trusted internals (recovery, bulk migration) may omit initiative.
    delete node.initiative;
  }
  addOptionalFields(node, input);
  return node;
}

async function prepare({ snapshot: rawSnapshot, input: rawInput }) {
  const snapshot = readSnapshot(rawSnapshot);
  const input = readInput(rawInput);
  const title = readRequiredText(input, "title", "title");
  const body = readRequiredText(input, "body", "body");
  const initiativeValues = validateInitiative(snapshot, input);
  const scope = validateScope(input);
  const status = validateStatus(input);
  const knowledgeType = validateKnowledgeType(input);
  const id = validateId(input);
  const supersedes = validateSupersedes(snapshot, id, input);
  const node = createNode(input, { id, title, body, ...initiativeValues, scope, status, knowledgeType });
  const plan = { target: { id, kind: "knowledge" }, policyAction: null, idempotent: false, node };
  if (supersedes !== null) {
    plan.supersedes = supersedes;
  }
  return plan;
}

function validateApplyPlan(plan) {
  const node = plan.node;
  if (!node || typeof node !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.create.apply: plan.node missing", { field: "plan.node" });
  }
  const id = node.id;
  if (typeof id !== "string" || id.length === 0) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      "knowledge.create.apply: node id is required (the upstream caller must supply one)",
      { field: "id" },
    );
  }
  return { node, id };
}

function applySupersession(tx, id, supersedes) {
  if (typeof supersedes !== "string" || supersedes.length === 0) {
    return;
  }
  // Knowledge nodes are never BLOCKS endpoints; supersession only updates
  // the target status and adds a SUPERSEDES edge.
  tx.updateNode(supersedes, { status: "superseded" });
  tx.addEdge({ from: id, to: supersedes, type: "SUPERSEDES" });
}

async function apply({ tx, plan }) {
  const { node, id } = validateApplyPlan(plan);
  tx.createNode({ ...node, id });
  applySupersession(tx, id, plan.supersedes);
  return { result: { id, kind: "knowledge" }, effects: null };
}

/**
 * knowledge.create provider factory.
 *
 * @returns {{
 *   prepare: (args: { snapshot: object, input: object, request: object }) => Promise<object>,
 *   apply: (args: { tx: object, plan: object }) => Promise<{ result: object }>,
 * }}
 */
export function createProvider() {
  return { prepare, apply };
}
