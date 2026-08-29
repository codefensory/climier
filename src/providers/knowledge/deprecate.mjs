// src/providers/knowledge/deprecate.mjs — `knowledge.deprecate` provider
// for the graph kernel (plan B4-knowledge-lifecycle).
//
// Implements the kernel provider contract from ADR-011 §1:
//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates that the target is an existing knowledge
//       node; surfaces the current revision as `if_revision` so the
//       kernel can validate the CAS under the lock; captures the
//       actor (request.actor) for the deprecation record.
//   - `apply({ tx, plan }) → { result, effects }`
//       patches the draft via `tx.updateNode`. Sets `status`,
//       `deprecation_reason`, `deprecated_at`, `deprecated_by` and
//       leaves every other field untouched (scope, knowledge_type,
//       mitigation, title, body, refs, meta, …). The kernel owns
//       revision assignment; this file never reads or writes the
//       `revision` field (see src/kernel/mutate.mjs + transaction.mjs).
//
// Behaviour parity (matches src/commands/deprecate-knowledge.mjs, the
// historical F12 handler). The provider supersedes that handler's
// in-process mutation, but the on-disk shape it produces is identical:
// every deprecated knowledge node carries `status: "deprecated"`,
// `deprecation_reason`, `deprecated_at` (ISO 8601), `deprecated_by`
// (the actor that ran the operation).
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI. The only side effect is on the
// caller-supplied `tx` draft.

import { throwV2 } from "../../errors.mjs";

const POLICY_ACTION = "knowledge.deprecate";
const COMMAND_OP = "knowledge.deprecate";

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}: snapshot must be an object`, { field: "snapshot" });
  }
  return snapshot;
}

function readInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", `${COMMAND_OP}: input must be an object`, { field: "input" });
  }
  return input;
}

function readRequest(request) {
  if (!request || typeof request !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}: request must be an object`, { field: "request" });
  }
  return request;
}

function readSnapshotNodes(snapshot) {
  return asPlainObject(snapshot.nodes) ? snapshot.nodes : {};
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0 || !value.trim()) {
    throwV2("MISSING_FIELD", `${COMMAND_OP}: '${field}' is required`, { field });
  }
  return value.trim();
}

/**
 * knowledge.deprecate provider factory.
 *
 * @returns {{
 *   prepare: (args: { snapshot: object, input: object, request: object }) => Promise<object>,
 *   apply: (args: { tx: object, plan: object }) => Promise<{ result: object, effects: object|null }>,
 * }}
 */
export function deprecateProvider() {
  return {
    /**
     * Validate the deprecation request and produce the plan. Read-only.
     *
     * Required input: { id, reason }. The `actor` is taken from
     * `request.actor` (consistent with the rest of the graph kernel:
     * providers do not own agent resolution; the agent is supplied by
     * the request envelope).
     *
     * The plan carries:
     *   - target: { id, kind: 'knowledge', revision } (current snapshot).
     *   - if_revision: { kind: 'single', id, value } so the kernel can
     *     validate the CAS under the lock.
     *   - policyAction: { action: 'knowledge.deprecate' } — the
     *     canonical policy action for this operation.
     *   - idempotent: false (a deprecation always records a fresh
     *     event; re-deprecating bumps revision and rewrites
     *     `deprecated_at`/`deprecated_by`).
     *   - reason: the trimmed deprecation reason (echoed back to
     *     apply and to the log entry).
     *   - actor: the request actor (echoed back to apply so the
     *     node carries `deprecated_by`).
     */
    async prepare({ snapshot: rawSnapshot, input: rawInput, request: rawRequest }) {
      const snapshot = readSnapshot(rawSnapshot);
      const input = readInput(rawInput);
      const request = readRequest(rawRequest);

      const id = requireNonEmptyString(input.id, "id");
      const reason = requireNonEmptyString(input.reason, "reason");
      const actor = requireNonEmptyString(request.actor, "actor");

      const nodes = readSnapshotNodes(snapshot);
      const current = nodes[id];
      if (!current) {
        throwV2("NODE_NOT_FOUND", `${COMMAND_OP}: node '${id}' does not exist`, { id });
      }
      if (current.kind !== "knowledge") {
        throwV2(
          "INVALID_PROVIDER_INPUT",
          `${COMMAND_OP}: node '${id}' is not a knowledge node (kind=${current.kind})`,
          { id, kind: current.kind },
        );
      }
      if (!Number.isInteger(current.revision)) {
        throwV2(
          "INVALID_PROVIDER_INPUT",
          `${COMMAND_OP}: node '${id}' has no integer revision`,
          { id, revision: current.revision },
        );
      }

      const plan = {
        target: { id, kind: "knowledge", revision: current.revision },
        if_revision: { kind: "single", id, value: current.revision },
        policyAction: { action: POLICY_ACTION },
        idempotent: false,
        reason,
        actor,
      };
      return plan;
    },

    /**
     * Apply the deprecation patch via tx.updateNode. Never sets
     * `revision`; the kernel diff bumps it once per node per apply.
     * The patch is intentionally minimal so the caller's scope,
     * knowledge_type, mitigation, title, body, refs, meta and any
     * other field stay untouched.
     */
    async apply({ tx, plan }) {
      if (!plan || typeof plan !== "object") {
        throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan missing`, { field: "plan" });
      }
      if (!plan.target || typeof plan.target.id !== "string" || plan.target.id.length === 0) {
        throwV2(
          "INVALID_EXECUTION_CONTRACT",
          `${COMMAND_OP}.apply: plan.target.id missing`,
          { field: "plan.target.id" },
        );
      }
      const reason = typeof plan.reason === "string" ? plan.reason : null;
      const actor = typeof plan.actor === "string" ? plan.actor : null;
      if (reason === null) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan.reason missing`, { field: "plan.reason" });
      }
      if (actor === null) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan.actor missing`, { field: "plan.actor" });
      }

      tx.updateNode(plan.target.id, {
        status: "deprecated",
        deprecation_reason: reason,
        deprecated_at: new Date().toISOString(),
        deprecated_by: actor,
      });
      return {
        result: {
          id: plan.target.id,
          kind: "knowledge",
          status: "deprecated",
        },
        effects: null,
      };
    },
  };
}
