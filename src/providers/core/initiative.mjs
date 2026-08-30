// src/providers/core/initiative.mjs — pure provider for `initiative.create`.
//
// T-graph-kernel-provider-core-initiative: completes the public surface of the
// graph kernel with an initiative-only operation that mirrors the public
// `add-initiative` CLI contract while running through `kernel.mutate`.
//
// Contract (ADR-011 §1 + §B6B):
//   - `prepare` is read-only. It validates the input shape, the
//     canonical `name` (`^[A-Za-z0-9_-]+$`, matching the legacy
//     add-initiative whitelist), the optional `desc`, and rejects
//     duplicates already present in the snapshot. The plan carries
//     `{ target, policyAction, logAction, initiative }`.
//   - `apply` only mutates the in-memory tx draft: exactly one
//     `tx.createInitiative` call. The provider stamps `created_at`
//     once at prepare time so apply never reaches for clock state.
//     The provider never writes `revision` (the kernel diff owns
//     that and does not bump node.revision for initiative-only
//     changes, per B1b).
//   - The provider is provider-only: it does NOT reach for argv,
//     never resolves to a legacy `handler`, and never imports
//     filesystem, lock, state, log, policy, commands, registry,
//     adapter, CLI or UI.

import { throwV2 } from "../../errors.mjs";

const OP = "initiative.create";
const LOG_ACTION = "add-initiative";
const POLICY_ACTION = "initiative.create";

// NAME_PATTERN — mirrors the legacy `add-initiative` whitelist so
// names registered through the provider match the names the legacy
// path accepts. The legacy handler's reject message references this
// pattern as `[A-Za-z0-9_-]+`; we keep the same surface verbatim so
// plugin authors and existing policies do not need to learn a new
// name shape.
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotInitiatives(snapshot) {
  // initiatives: { name -> { desc?, created_at? } }. The v2 schema
  // keeps it as a plain object; defensive read in case a future
  // plugin ships a partial snapshot.
  return snapshot && snapshot.initiatives && typeof snapshot.initiatives === "object" && !Array.isArray(snapshot.initiatives)
    ? snapshot.initiatives
    : {};
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input must be an object`,
      { field: "input" },
    );
  }
  const name = asNonEmptyString(input.name);
  if (!name) {
    throwV2("MISSING_FIELD", `${OP}: --name required (e.g. --name auth-migration)`, { field: "name" });
  }
  if (!NAME_PATTERN.test(name)) {
    throwV2(
      "INVALID_NAME",
      `${OP}: name '${name}' is invalid (must match ${NAME_PATTERN})`,
      { name, pattern: NAME_PATTERN.source },
    );
  }
  // desc is optional. When present it must be a string; the legacy
  // add-initiative handler normalises missing desc to "" but here we
  // keep it strictly typed so the kernel diff stays unambiguous
  // (an absent desc and an empty desc are different states).
  if (input.desc !== undefined && input.desc !== null && typeof input.desc !== "string") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: --desc must be a string when present`,
      { field: "desc" },
    );
  }
  return { name };
}

function validateNoConflict(name, snapshot) {
  const initiatives = readSnapshotInitiatives(snapshot);
  if (Object.prototype.hasOwnProperty.call(initiatives, name)) {
    throwV2(
      "ID_CONFLICT",
      `${OP}: initiative '${name}' already exists in the snapshot`,
      {
        name,
        existing: {
          desc: typeof initiatives[name].desc === "string" ? initiatives[name].desc : "",
          created_at: typeof initiatives[name].created_at === "string"
            ? initiatives[name].created_at
            : null,
        },
      },
    );
  }
}

/**
 * Pure `prepare` for initiative.create.
 *
 * Contract:
 *   - read-only: never mutates the snapshot, never reaches outside
 *     the provided arguments;
 *   - validates input shape, name pattern, optional desc type, and
 *     rejects names already registered in the snapshot;
 *   - returns a frozen plan: `{ target, policyAction, logAction,
 *     initiative }`. `target.id` is the initiative name so the
 *     kernel can build a log entry without learning the initiative
 *     domain. `initiative` carries the canonical `{ name, desc,
 *     created_at }` payload that `apply` forwards to
 *     `tx.createInitiative`.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  // `request` is accepted for symmetry with the kernel contract
  // (B6B providers receive it) but is not consumed today: validation
  // is driven entirely by the snapshot and the input. Referenced so
  // the linter does not flag the parameter and so future slices can
  // read request metadata without re-plumbing the call site.
  void request;
  const { name } = validateInputShape(input);
  validateNoConflict(name, snapshot);

  // created_at is stamped at prepare time so apply never reaches for
  // clock state. The legacy add-initiative handler stamps the same
  // instant inside its `updateState` callback; doing it here keeps
  // the same observable behaviour for callers while preserving the
  // provider-only contract.
  const createdAt = new Date().toISOString();
  const desc = typeof input.desc === "string" ? input.desc : "";

  const initiative = Object.freeze({
    name,
    desc,
    created_at: createdAt,
  });

  return Object.freeze({
    target: Object.freeze({
      id: name,
      // `kind` is a registry-internal marker for `initiative.create`
      // (no v2 node has `kind === "initiative"`); kernel.mutate
      // reads only `target.id` for the log entry, but downstream
      // consumers (audit / inspector tools) may inspect `kind` to
      // distinguish initiative operations from resolvable/knowledge
      // ones.
      kind: "initiative",
    }),
    policyAction: Object.freeze({ action: POLICY_ACTION, pluginId: null }),
    logAction: LOG_ACTION,
    initiative,
  });
}

/**
 * Pure `apply` for initiative.create.
 *
 * Contract:
 *   - mutates the tx draft only via exactly one `tx.createInitiative`;
 *   - reads no clock, no filesystem, no lock, no state, no log;
 *   - never writes `revision` (the kernel diff owns it);
 *   - returns `{ result, effects }` with the persisted initiative
 *     shape projected for the caller.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.createInitiative !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with createInitiative accessor`,
      { field: "tx" },
    );
  }
  // The plan already carries the canonical payload (name, desc,
  // created_at) so apply never has to re-read input or re-stamp the
  // timestamp. The kernel validates the plan was produced by the
  // provider's prepare under the lock, so we trust it as-is.
  const persisted = tx.createInitiative({
    name: plan.initiative.name,
    desc: plan.initiative.desc,
    created_at: plan.initiative.created_at,
  });
  return {
    result: Object.freeze({
      name: plan.initiative.name,
      desc: plan.initiative.desc,
      created_at: plan.initiative.created_at,
      // The apply result intentionally does not surface the raw
      // tx output (it may include stripped keys); the contract for
      // callers is `{ name, desc, created_at }`.
      persisted: persisted && typeof persisted === "object" ? Object.freeze({ ...persisted }) : null,
    }),
    effects: null,
  };
}

// This is the only built-in provider allowed to initialize a missing v2
// state. kernel.mutate checks this explicit capability together with the
// operation id; other providers retain the run-init-first failure.
export const initiativeCreateProvider = Object.freeze({
  prepare,
  apply,
  bootstrapMissingState: true,
});