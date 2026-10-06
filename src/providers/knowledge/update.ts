// src/providers/knowledge/update.ts — `knowledge.update` provider for
// the graph kernel.

//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates domain rules and emits a plan carrying
//       `{ target, if_revision, policyAction, idempotent, changes }`.
//       The kernel validates `if_revision` under the lock; we surface
//       the expected revision so callers can use the same precondition

//   - `apply({ tx, plan }) → { result }`
//       patches the draft via `tx.updateNode`. The kernel diff bumps
//       `revision` by 1 when the patch actually changes the node; an
//       idempotent patch (same fields → same values) produces no diff.
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { throwV2 } from "../../contracts/errors.ts";

const KNOWN_KNOWLEDGE_TYPES = Object.freeze(["warning", "fact", "instruction"]);
const KNOWN_STATUSES = Object.freeze(["active", "deprecated", "superseded"]);
const SCOPE_KEYS = Object.freeze(["domains", "initiatives", "tags", "node_ids"]);
export const PATCHABLE_FIELDS = Object.freeze([
  "title",
  "body",
  "mitigation",
  "knowledge_type",
  "scope",
  "status",
  "domain",
  "tags",
  "refs",
  "meta",
]);

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function readInput(input) {
  if ((input === null || input === undefined) || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", "knowledge.update: input must be an object", { field: "input" });
  }
  return input;
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.update: snapshot must be an object", { field: "snapshot" });
  }
  return snapshot;
}

function readNodes(snapshot) {
  return snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function normalizeScope(rawScope) {
  if ((rawScope === null || rawScope === undefined) || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return null;
  }
  // `scope` is replaced wholesale by tx.updateNode, so emit all canonical
  // arrays and use [] for every key omitted by the input.
  const normalized = { domains: [], initiatives: [], tags: [], node_ids: [] };
  for (const key of SCOPE_KEYS) {
    if (Array.isArray(rawScope[key])) {
      normalized[key] = rawScope[key].slice();
    }
  }
  return normalized;
}

function pickChanges(rawChanges) {
  if ((rawChanges === null || rawChanges === undefined) || typeof rawChanges !== "object" || Array.isArray(rawChanges)) {
    throwV2("MISSING_FIELD", "knowledge.update: changes must be an object", { field: "changes" });
  }

  const unknown = Object.keys(rawChanges).filter((field) => !PATCHABLE_FIELDS.includes(field));
  if (unknown.length > 0) {
    const allowed = [...PATCHABLE_FIELDS].toSorted();
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `knowledge.update: changes.${unknown[0]} is not a valid patch key (allowed: ${allowed.join(", ")})`,
      { field: `changes.${unknown[0]}`, allowed },
    );
  }
  const changes = {};
  for (const field of PATCHABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawChanges, field)) {
      changes[field] = rawChanges[field];
    }
  }
  if (Object.keys(changes).length === 0) {
    throwV2("MISSING_FIELD", "knowledge.update: changes must include at least one patchable field", {
      field: "changes",
      allowed: [...PATCHABLE_FIELDS],
    });
  }
  return changes;
}

function validateTarget(nodes, id) {
  const current = nodes[id];
  if (!current) {
    throwV2("NODE_NOT_FOUND", `knowledge.update: node '${id}' does not exist`, { field: "id", id });
  }
  if (current.kind !== "knowledge") {
    throwV2("INVALID_PROVIDER_INPUT", `knowledge.update: node '${id}' is not a knowledge node (kind=${current.kind})`, {
      field: "id",
      id,
      kind: current.kind,
    });
  }
  if (!Number.isInteger(current.revision)) {
    throwV2("INVALID_PROVIDER_INPUT", `knowledge.update: node '${id}' has no integer revision`, {
      field: "revision",
      id,
      revision: current.revision,
    });
  }
  return current;
}

function validateEnum(changes, field, allowed) {
  if (!Object.prototype.hasOwnProperty.call(changes, field)) {
    return;
  }
  const value = asString(changes[field]);
  if (!allowed.includes(value)) {
    throwV2(
      "INVALID_PROVIDER_INPUT",
      `knowledge.update: ${field} '${value}' is not allowed (allowed: ${allowed.join(", ")})`,
      { field, value, allowed },
    );
  }
}

function normalizeChanges(changes) {
  validateEnum(changes, "knowledge_type", KNOWN_KNOWLEDGE_TYPES);
  validateEnum(changes, "status", KNOWN_STATUSES);
  if (changes.scope !== undefined) {
    const scope = normalizeScope(changes.scope);
    if (scope === null) {
      throwV2("MISSING_FIELD", "knowledge.update: scope must be an object", { field: "scope" });
    }
    changes.scope = scope;
  }
  if (Array.isArray(changes.refs)) {
    changes.refs = changes.refs.map((ref) => (ref && typeof ref === "object") ? { ...ref } : ref);
  }
  if (changes.meta !== undefined && changes.meta !== null && typeof changes.meta === "object" && !Array.isArray(changes.meta)) {
    changes.meta = { ...changes.meta };
  }
  return changes;
}

function createPlan(id, current, changes) {
  return {
    target: { id, kind: "knowledge", revision: current.revision },
    if_revision: { kind: "single", id, value: current.revision },
    policyAction: null,
    idempotent: false,
    changes,
  };
}

async function prepare({ snapshot: rawSnapshot, input: rawInput }) {
  const snapshot = readSnapshot(rawSnapshot);
  const input = readInput(rawInput);
  const id = asNonEmptyString(input.id);
  if (!id) {
    throwV2("MISSING_FIELD", "knowledge.update: id is required", { field: "id" });
  }
  const current = validateTarget(readNodes(snapshot), id);
  const changes = normalizeChanges(pickChanges(input.changes));
  return createPlan(id, current, changes);
}

async function apply({ tx, plan }) {
  if (!plan || typeof plan !== "object" || !plan.target || typeof plan.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.update.apply: plan.target.id missing", { field: "plan.target.id" });
  }
  if (!plan.changes || typeof plan.changes !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.update.apply: plan.changes missing", { field: "plan.changes" });
  }
  tx.updateNode(plan.target.id, { ...plan.changes });
  return { result: { id: plan.target.id, kind: "knowledge" }, effects: null };
}


export function updateProvider() {
  return { prepare, apply };
}
