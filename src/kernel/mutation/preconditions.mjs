// Kernel mutation precondition contracts.
//
// This module is deliberately pure: it validates caller/provider CAS
// declarations against the snapshot supplied by the mutation pipeline and
// performs no filesystem or lock operations. The caller is responsible for
// invoking it after the fresh snapshot is read and while the lock is held.

import { throwV2 } from "../../contracts/errors.mjs";

/**
 * Select the CAS declaration for a mutation.
 *
 * A request declaration is agent-facing and takes precedence over a provider
 * plan declaration. Both the singular and plural legacy spellings are
 * preserved; the selected value is validated by checkPrecondition.
 */
function declaredPrecondition(value) {
  if (!value) {return undefined;}
  if (value.if_revision !== undefined) {return value.if_revision;}
  return value.if_revisions;
}

export function selectPrecondition(request, plan) {
  const requested = declaredPrecondition(request);
  return requested !== undefined ? requested : declaredPrecondition(plan);
}

/**
 * Validate a single-node, multi-node, or explicitly absent CAS declaration
 * against the fresh snapshot. Returns the normalized shape used by kernel
 * internals, or null when no declaration was provided.
 */
export function checkStateRevision(expected, snapshot, commandName) {
  if (expected === undefined || expected === null) {return null;}
  if (!Number.isInteger(expected) || expected < 0) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: if_state_revision must be a non-negative integer`,
      { field: "if_state_revision", value: expected },
    );
  }
  const actual = snapshot && Number.isInteger(snapshot.revision) ? snapshot.revision : null;
  if (actual !== expected) {
    throwV2(
      "STATE_REVISION_CONFLICT",
      `${commandName}: state changed since revision ${expected}`,
      { expected, actual },
    );
  }
  return expected;
}

function snapshotNode(snapshot, id) {
  return snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
}

function currentRevision(node) {
  return node && Number.isInteger(node.revision) ? node.revision : null;
}

function assertRevisionMatches(id, expected, snapshot, commandName) {
  const node = snapshotNode(snapshot, id);
  const current = currentRevision(node);
  if (!node || current === null || current !== expected) {
    throwV2("REVISION_CONFLICT", `${commandName}: node ${id} changed since revision ${expected}`, { id, expected, current });
  }
}

function checkSinglePrecondition(precondition, snapshot, commandName) {
  const id = typeof precondition.id === "string" ? precondition.id : null;
  const expected = Number(precondition.value);
  if (!id || !Number.isInteger(expected)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision{ single } requires id+integer value`, { field: "if_revision" });
  }
  assertRevisionMatches(id, expected, snapshot, commandName);
  return { kind: "single", id, value: expected };
}

function preconditionValues(precondition, commandName) {
  const values = precondition.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions{ multi } requires a values object`, { field: "if_revisions" });
  }
  return values;
}

function checkMultiPrecondition(precondition, snapshot, commandName) {
  const values = preconditionValues(precondition, commandName);
  const checked = [];
  for (const [id, raw] of Object.entries(values)) {
    const expected = Number(raw);
    if (!Number.isInteger(expected)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions[${id}] must be an integer`, { field: "if_revisions" });
    }
    assertRevisionMatches(id, expected, snapshot, commandName);
    checked.push(id);
  }
  return { kind: "multi", values, ids: checked };
}

export function checkPrecondition(precondition, snapshot, commandName) {
  if (precondition === undefined || precondition === null) {return null;}
  if (typeof precondition !== "object" || Array.isArray(precondition)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision must be an object`, { field: "if_revision" });
  }
  if (precondition.kind === "single") {return checkSinglePrecondition(precondition, snapshot, commandName);}
  if (precondition.kind === "multi") {return checkMultiPrecondition(precondition, snapshot, commandName);}
  if (precondition.kind === "none") {
    // Explicit "no precondition" — reserved for trusted internals
    // (migrations, restore). The caller is responsible for documenting
    // why the agent-facing CAS is intentionally absent.
    return { kind: "none" };
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${commandName}: if_revision.kind must be one of single|multi|none`,
    { field: "if_revision.kind", value: precondition.kind },
  );
}
