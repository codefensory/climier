// Stable kernel mutation façade.
//
// The façade owns only the public entry point, the project lock and the
// async-chain re-entrancy guard. The mutation algorithm lives in
// ./mutation/execute.mjs. Pure helper exports below are retained for
// compatibility with kernel tests and internal callers.

import { AsyncLocalStorage } from "node:async_hooks";
import { withLock } from "../storage/lock.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import {
  commandLabel,
  operationLabel,
  executeMutation,
  executeBatchMutation,
  freezePlan,
  validateMutationArguments,
} from "./mutation/execute.mjs";
import {
  checkPrecondition,
  checkStateRevision,
  selectPrecondition,
} from "./mutation/preconditions.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "./mutation/diff.mjs";
import { deriveTargetRevision } from "./mutation/revisions.mjs";
import { normalizeLogFields, validateDraftStructural } from "./mutation/validation.mjs";
import { buildLogEntry } from "./mutation/log-entry.mjs";
import {
  validatePlan,
  validateProvider,
  validateRequest,
} from "./mutation/request.mjs";

// AsyncLocalStorage scopes the nested mutation guard to one async chain. Two
// independent calls may therefore execute concurrently and serialize only at
// the project lock, while provider.apply -> mutate is rejected immediately.
const nestedDepthStorage = new AsyncLocalStorage();

function currentNestedDepth() {
  const store = nestedDepthStorage.getStore();
  return typeof store === "number" ? store : 0;
}

/**
 * Stable kernel mutation API. All reads, provider callbacks and persistence
 * run through one project lock and are delegated to the execution coordinator.
 */
export async function mutate({ projectDir, request, provider, policyAction, pluginId, stateOperation, batch }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation, batch });
  const parentDepth = currentNestedDepth();
  if (parentDepth > 0) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: nested kernel.mutate is rejected (the kernel is single-entry; providers must not mutate)`,
      { field: "mutate", depth: parentDepth + 1 },
    );
  }

  return nestedDepthStorage.run(parentDepth + 1, () =>
    withLock(projectDir, () => executeMutation({
      projectDir,
      request,
      provider,
      policyAction,
      pluginId,
      stateOperation,
      batch,
    })),
  );
}

export const __kernelInternals = Object.freeze({
  commandLabel,
  operationLabel,
  executeMutation,
  executeBatchMutation,
  freezePlan,
  validateMutationArguments,
  checkPrecondition,
  checkStateRevision,
  selectPrecondition,
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  validateDraftStructural,
  validateRequest,
  validateProvider,
  validatePlan,
  deepEqualNodes,
  deriveTargetRevision,
  normalizeLogFields,
  buildLogEntry,
});
