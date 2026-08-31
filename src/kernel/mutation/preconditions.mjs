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
export function selectPrecondition(request, plan) {
  const requestedIf = request && request.if_revision !== undefined
    ? request.if_revision
    : (request && request.if_revisions !== undefined ? request.if_revisions : undefined);
  const planIf = plan && plan.if_revision !== undefined
    ? plan.if_revision
    : (plan && plan.if_revisions !== undefined ? plan.if_revisions : undefined);
  return requestedIf !== undefined ? requestedIf : planIf;
}

/**
 * Validate a single-node, multi-node, or explicitly absent CAS declaration
 * against the fresh snapshot. Returns the historical normalized shape used by
 * kernel internals, or null when no declaration was provided.
 */
export function checkPrecondition(precondition, snapshot, commandName) {
  if (precondition === undefined || precondition === null) return null;
  if (typeof precondition !== "object" || Array.isArray(precondition)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision must be an object`, { field: "if_revision" });
  }
  const kind = precondition.kind;
  if (kind === "single") {
    const id = typeof precondition.id === "string" ? precondition.id : null;
    const expected = Number(precondition.value);
    if (!id || !Number.isInteger(expected)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision{ single } requires id+integer value`, { field: "if_revision" });
    }
    const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
    const current = node && Number.isInteger(node.revision) ? node.revision : null;
    if (!node || current === null || current !== expected) {
      throwV2(
        "REVISION_CONFLICT",
        `${commandName}: node ${id} changed since revision ${expected}`,
        { id, expected, current },
      );
    }
    return { kind: "single", id, value: expected };
  }
  if (kind === "multi") {
    const values = precondition.values && typeof precondition.values === "object" && !Array.isArray(precondition.values)
      ? precondition.values
      : null;
    if (!values) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions{ multi } requires a values object`, { field: "if_revisions" });
    }
    const checked = [];
    for (const [id, raw] of Object.entries(values)) {
      const expected = Number(raw);
      if (!Number.isInteger(expected)) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions[${id}] must be an integer`, { field: "if_revisions" });
      }
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      const current = node && Number.isInteger(node.revision) ? node.revision : null;
      if (!node || current === null || current !== expected) {
        throwV2(
          "REVISION_CONFLICT",
          `${commandName}: node ${id} changed since revision ${expected}`,
          { id, expected, current },
        );
      }
      checked.push(id);
    }
    return { kind: "multi", values, ids: checked };
  }
  if (kind === "none") {
    // Explicit "no precondition" — reserved for trusted internals
    // (migrations, restore). The caller is responsible for documenting
    // why the agent-facing CAS is intentionally absent.
    return { kind: "none" };
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${commandName}: if_revision.kind must be one of single|multi|none`,
    { field: "if_revision.kind", value: kind },
  );
}
