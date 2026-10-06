// Stable kernel mutation façade.
// The façade owns only the public entry point, the project lock and the
// async-chain re-entrancy guard. The mutation algorithm lives in
// ./mutation/execute.mjs. Pure helper exports below are retained for
// compatibility with kernel tests and internal callers.

import { AsyncLocalStorage } from "node:async_hooks";
import { withLock } from "../storage/lock.ts";
import { throwV2 } from "../contracts/errors.ts";
import {
  commandLabel,
  operationLabel,
  executeMutation,
  executeBatchMutation,
  freezePlan,
  validateMutationArguments,
} from "./mutation/execute.ts";
import {
  checkPrecondition,
  checkStateRevision,
  selectPrecondition,
} from "./mutation/preconditions.ts";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "./mutation/diff.ts";
import { deriveTargetRevision } from "./mutation/revisions.ts";
import { normalizeLogFields, validateDraftStructural } from "./mutation/validation.ts";
import { buildLogEntry } from "./mutation/log-entry.ts";
import {
  validatePlan,
  validateProvider,
  validateRequest,
} from "./mutation/request.ts";

// AsyncLocalStorage scopes the nested mutation guard to one async chain. Two
// independent calls may therefore execute concurrently and serialize only at
// the project lock, while provider.apply -> mutate is rejected immediately.
const nestedDepthStorage = new AsyncLocalStorage();

function currentNestedDepth() {
  const store = nestedDepthStorage.getStore();
  return typeof store === "number" ? store : 0;
}


function takeoverAbstainError(args) {
  const error = new Error(`take: task '${args.target.id}' is already claimed`);
  error.code = "POLICY_TAKEOVER_ABSTAIN";
  error.details = { id: args.target.id, owner: args.target.previous_owner || null };
  return error;
}

function policyDecision(policyAction, selectedAction, args) {
  if (typeof policyAction.decide !== "function") {return { decision: "abstain" };}
  return policyAction.decide({ ...args, action: selectedAction });
}

function wrapPrepare(request, provider, selectAction) {
  return {
    ...provider,
    async prepare(args) {
      const plan = await provider.prepare(args);
      if (plan && plan.policyAction && typeof plan.policyAction.action === "string" && plan.policyAction.action.length > 0) {
        selectAction(plan.policyAction.action);
      }
      if (plan && typeof plan.logAction === "string" && plan.logAction.length > 0) {request.action = plan.logAction;}
      return plan;
    },
  };
}

function wrapPolicyAction(policyAction, getAction) {
  return {
    ...policyAction,
    get action() { return getAction(); },
    async decide(args) {
      const selectedAction = getAction();
      const decision = policyAction ? await policyDecision(policyAction, selectedAction, args) : { decision: "abstain" };
      if (selectedAction === "task.takeover" && decision && decision.decision === "abstain") {throw takeoverAbstainError(args);}
      return decision;
    },
  };
}

function selectPolicyAndAuditFromPlan({ request, provider, policyAction }) {
  let selectedAction = request.action;
  const wrappedProvider = wrapPrepare(request, provider, (action) => { selectedAction = action; });
  const wrappedPolicyAction = wrapPolicyAction(policyAction, () => selectedAction);
  return { provider: wrappedProvider, policyAction: wrappedPolicyAction };
}

export async function mutate({ projectDir, request, provider, policyAction, policyActionFromPlan, pluginId, stateOperation, batch }) {
  if (policyActionFromPlan === true) {
    ({ provider, policyAction } = selectPolicyAndAuditFromPlan({ request, provider, policyAction }));
  }
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
    withLock(projectDir, (lockContext) => executeMutation({
      projectDir,
      lockContext,
      request,
      provider,
      policyAction,
      pluginId,
      stateOperation,
      batch,
    })),
  );
}

const kernelInternals = Object.freeze({
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

export { kernelInternals as "__kernelInternals" };
