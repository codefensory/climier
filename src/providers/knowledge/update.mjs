// src/providers/knowledge/update.mjs — `knowledge.update` provider for
// the graph kernel.
//
// Implements the kernel provider contract from ADR-011 §1:
//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates domain rules and emits a plan carrying
//       `{ target, if_revision, policyAction, idempotent, changes }`.
//       The kernel validates `if_revision` under the lock; we surface
//       the expected revision so callers can use the same precondition
//       contract as the v2 CLI.
//   - `apply({ tx, plan }) → { result }`
//       patches the draft via `tx.updateNode`. The kernel diff bumps
//       `revision` by 1 when the patch actually changes the node; an
//       idempotent patch (same fields → same values) produces no diff.
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { throwV2 } from "../../contracts/errors.mjs";

const KNOWN_KNOWLEDGE_TYPES = Object.freeze(["warning", "fact", "instruction"]);
const KNOWN_STATUSES = Object.freeze(["active", "deprecated", "superseded"]);
const SCOPE_KEYS = Object.freeze(["domains", "initiatives", "tags", "node_ids"]);
const PATCHABLE_FIELDS = Object.freeze([
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
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
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
  if (rawScope == null || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return null;
  }
  // Provider accepts any subset of the four scope arrays, but always emits
  // the four canonical arrays (same normalization as knowledge.create).
  // `tx.updateNode` merges at field level, so `scope` is replaced wholesale:
  // emitting a partial object would silently drop the scope arrays the patch
  // did not mention. Absent keys therefore normalize to [].
  const out = { domains: [], initiatives: [], tags: [], node_ids: [] };
  for (const key of SCOPE_KEYS) {
    if (Array.isArray(rawScope[key])) out[key] = rawScope[key].slice();
  }
  return out;
}

function pickChanges(rawChanges) {
  if (rawChanges == null || typeof rawChanges !== "object" || Array.isArray(rawChanges)) {
    throwV2("MISSING_FIELD", "knowledge.update: changes must be an object", { field: "changes" });
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

/**
 * knowledge.update provider factory.
 *
 * @returns {{
 *   prepare: (args: { snapshot: object, input: object, request: object }) => Promise<object>,
 *   apply: (args: { tx: object, plan: object }) => Promise<{ result: object }>,
 * }}
 */
export function updateProvider() {
  return {
    /**
     * Validate the update request and produce the plan. Read-only.
     *
     * Required input: { id, changes }. The `changes` object accepts:
     *   - title, body, mitigation (string)
     *   - knowledge_type (one of warning|fact|instruction)
     *   - status (one of active|deprecated|superseded)
     *   - domain (string), tags (string[]), refs, meta
     *   - scope: { domains?, initiatives?, tags?, node_ids? }
     *
     * Returns a plan with `target.revision` reflecting the current
     * revision read from the snapshot and an `if_revision` precondition
     * (single) so the kernel can validate against the fresh snapshot.
     */
    async prepare({ snapshot: rawSnapshot, input: rawInput }) {
      const snapshot = readSnapshot(rawSnapshot);
      const input = readInput(rawInput);
      const id = asNonEmptyString(input.id);
      if (!id) {
        throwV2("MISSING_FIELD", "knowledge.update: id is required", { field: "id" });
      }

      const nodes = readNodes(snapshot);
      const current = nodes[id];
      if (!current) {
        throwV2("NODE_NOT_FOUND", `knowledge.update: node '${id}' does not exist`, { field: "id", id });
      }
      if (current.kind !== "knowledge") {
        throwV2(
          "INVALID_PROVIDER_INPUT",
          `knowledge.update: node '${id}' is not a knowledge node (kind=${current.kind})`,
          { field: "id", id, kind: current.kind },
        );
      }
      if (!Number.isInteger(current.revision)) {
        throwV2(
          "INVALID_PROVIDER_INPUT",
          `knowledge.update: node '${id}' has no integer revision`,
          { field: "revision", id, revision: current.revision },
        );
      }

      const changes = pickChanges(input.changes);

      if (Object.prototype.hasOwnProperty.call(changes, "knowledge_type")) {
        const kt = asString(changes.knowledge_type);
        if (!KNOWN_KNOWLEDGE_TYPES.includes(kt)) {
          throwV2(
            "INVALID_PROVIDER_INPUT",
            `knowledge.update: knowledge_type '${kt}' is not allowed (allowed: ${KNOWN_KNOWLEDGE_TYPES.join(", ")})`,
            { field: "knowledge_type", value: kt, allowed: KNOWN_KNOWLEDGE_TYPES },
          );
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, "status")) {
        const st = asString(changes.status);
        if (!KNOWN_STATUSES.includes(st)) {
          throwV2(
            "INVALID_PROVIDER_INPUT",
            `knowledge.update: status '${st}' is not allowed (allowed: ${KNOWN_STATUSES.join(", ")})`,
            { field: "status", value: st, allowed: KNOWN_STATUSES },
          );
        }
      }
      const normalizedScope = normalizeScope(changes.scope);
      if (changes.scope !== undefined) {
        if (normalizedScope === null) {
          throwV2("MISSING_FIELD", "knowledge.update: scope must be an object", { field: "scope" });
        }
        changes.scope = normalizedScope;
      }
      // Refs/meta copies to avoid reference sharing between plan and
      // caller-supplied object.
      if (Array.isArray(changes.refs)) {
        changes.refs = changes.refs.map((ref) => (ref && typeof ref === "object") ? { ...ref } : ref);
      }
      if (changes.meta !== undefined && changes.meta !== null && typeof changes.meta === "object" && !Array.isArray(changes.meta)) {
        changes.meta = { ...changes.meta };
      }

      const plan = {
        target: { id, kind: "knowledge", revision: current.revision },
        if_revision: { kind: "single", id, value: current.revision },
        policyAction: null,
        idempotent: false,
        changes,
      };
      return plan;
    },

    /**
     * Apply the patch via tx.updateNode. Never sets `revision`; the
     * kernel diff bumps it once per node per apply when the patch
     * actually changes the node (idempotent → no bump).
     */
    async apply({ tx, plan }) {
      if (!plan || typeof plan !== "object" || !plan.target || typeof plan.target.id !== "string") {
        throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.update.apply: plan.target.id missing", { field: "plan.target.id" });
      }
      if (!plan.changes || typeof plan.changes !== "object") {
        throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.update.apply: plan.changes missing", { field: "plan.changes" });
      }
      tx.updateNode(plan.target.id, { ...plan.changes });
      return { result: { id: plan.target.id, kind: "knowledge" }, effects: null };
    },
  };
}
