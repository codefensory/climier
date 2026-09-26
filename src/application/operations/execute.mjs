// Application-level composition for registered operations.
// Hosts provide the registry and mutation frontier explicitly.

import { throwV2 } from "../../contracts/errors.mjs";

function contractError(message, field, details = {}) {
  throwV2("INVALID_EXECUTION_CONTRACT", `application.executeOperation: ${message}`, { field, ...details });
}

function validateProjectDir(projectDir) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {contractError("projectDir is required", "projectDir");}
}

function validateActor(actor) {
  if (typeof actor !== "string" || actor.length === 0) {contractError("actor is required", "actor");}
}

function validateOperation(operation) {
  if (typeof operation !== "string" || operation.length === 0) {contractError("operation is required", "operation");}
}

function validateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {contractError("source is required", "source");}
}

function validateArguments({ projectDir, actor, operation, source }) {
  validateProjectDir(projectDir);
  validateActor(actor);
  validateOperation(operation);
  validateSource(source);
}

function resolveMutation(source) {
  const kernelMutate = source.kernel && typeof source.kernel.mutate === "function" ? source.kernel.mutate : null;
  const mutate = typeof source.mutate === "function" ? source.mutate : kernelMutate;
  if (!mutate) {contractError("source.mutate must be a function", "source.mutate");}
  return mutate;
}

function resolveRegistry(source) {
  if (!source.registry || typeof source.registry !== "object" || typeof source.registry.lookup !== "function") {
    contractError("source.registry.lookup must be a function", "source.registry.lookup");
  }
  return source.registry;
}

function resolveProvider(registry, operation) {
  const entry = registry.lookup(operation);
  if (!entry || typeof entry !== "object") {
    const error = new Error(`application.executeOperation: operation '${operation}' is not registered`);
    error.code = "OPERATION_NOT_FOUND";
    error.details = { operation };
    throw error;
  }
  const provider = entry.provider || entry;
  if (!provider || typeof provider !== "object" || typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
    contractError(`registry entry for '${operation}' must provide prepare and apply functions`, "source.registry", { operation });
  }
  return provider;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function addRevisionPreconditions(request, input) {
  if (Object.prototype.hasOwnProperty.call(input, "if_state_revision")) {
    request.if_state_revision = input.if_state_revision;
  }
  if (typeof input.id === "string" && input.id.length > 0 && Number.isInteger(input.if_revision) && input.if_revision >= 1) {
    request.if_revision = { kind: "single", id: input.id, value: input.if_revision };
    return;
  }
  if (isRecord(input.if_revisions)) {request.if_revision = { kind: "multi", values: input.if_revisions };}
}

function buildRequest({ operation, actor, input }) {
  const request = { action: operation, actor, input };
  if (isRecord(input)) {addRevisionPreconditions(request, input);}
  return request;
}

function resolvePolicySelector(source) {
  if (typeof source.selectPolicy === "function") {return source.selectPolicy;}
  if (typeof source.loadApplicablePolicy === "function") {return source.loadApplicablePolicy;}
  return null;
}

function resolveAuthorizer(source) {
  if (typeof source.authorizeAction === "function") {return source.authorizeAction;}
  if (typeof source.authorize === "function") {return source.authorize;}
  return null;
}

function abstainPolicyAction(operation) {
  return { action: operation, async decide() { return { decision: "abstain" }; } };
}

function policyDecision({ policy, operation, projectDir, authorizeAction }) {
  return {
    action: operation,
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return authorizeAction({
        policy,
        action: action || operation,
        actor: request.actor,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig,
      });
    },
  };
}

async function buildPolicyAction({ source, projectDir, operation, policyActionFromPlan = false }) {
  const abstainAction = policyActionFromPlan ? abstainPolicyAction(operation) : null;
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) {return abstainAction;}
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) {return abstainAction;}
  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");}
  return policyDecision({ policy, operation, projectDir, authorizeAction });
}

async function buildBatchPolicyAction({ source, projectDir }) {
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) {return null;}
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) {return null;}
  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");}
  return {
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return authorizeAction({ policy, action, actor: request.actor, target, snapshot, projectDir, projectConfig: policy.projectConfig });
    },
  };
}

function addPluginId(mutation, source) {
  if (typeof source.pluginId === "string" && source.pluginId.length > 0) {mutation.pluginId = source.pluginId;}
  return mutation;
}

function singleMutation({ projectDir, request, provider, policyAction, policyActionFromPlan, source }) {
  const mutation = { projectDir, request, provider };
  if (policyActionFromPlan === true) {mutation.policyActionFromPlan = true;}
  if (policyAction) {mutation.policyAction = policyAction;}
  return addPluginId(mutation, source);
}

async function mutateOperation(mutate, mutation, policyActionFromPlan) {
  try {
    return await mutate(mutation);
  } catch (error) {
    if (policyActionFromPlan === true && error && error.code === "POLICY_TAKEOVER_ABSTAIN") {
      throwV2("ALREADY_CLAIMED", error.message, error.details);
    }
    throw error;
  }
}

function assertArgumentsObject(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {contractError("arguments must be an object", "arguments");}
}

function operationDependencies(args) {
  const { projectDir, actor, operation, input, source } = args;
  validateArguments({ projectDir, actor, operation, source });
  const registry = resolveRegistry(source);
  const mutate = resolveMutation(source);
  const provider = resolveProvider(registry, operation);
  return { projectDir, actor, operation, input, source, registry, mutate, provider };
}

/**
 * Compose one registered operation and delegate it once to the kernel.
 * The caller supplies the registry, mutation frontier, and optional policy source.
 */
export async function executeOperation(args = {}) {
  assertArgumentsObject(args);
  const dependencies = operationDependencies(args);
  const request = buildRequest(dependencies);
  const policyAction = await buildPolicyAction({
    source: dependencies.source,
    projectDir: dependencies.projectDir,
    operation: dependencies.operation,
    policyActionFromPlan: args.policyActionFromPlan === true,
  });
  const mutation = singleMutation({ ...dependencies, request, policyAction, policyActionFromPlan: args.policyActionFromPlan, source: dependencies.source });
  return mutateOperation(dependencies.mutate, mutation, args.policyActionFromPlan);
}

function batchInput(args) {
  const input = isRecord(args.input) ? args.input : { operations: args.operations };
  const operations = args.operations === undefined ? input.operations : args.operations;
  const expectedRevision = args.if_state_revision === undefined ? input.if_state_revision : args.if_state_revision;
  const request = { action: "core.batch", actor: args.actor, input: { operations } };
  if (expectedRevision !== undefined) {request.if_state_revision = expectedRevision;}
  return request;
}

async function batchMutation({ args, registry, mutate, source }) {
  const request = batchInput(args);
  const policyAction = await buildBatchPolicyAction({ source, projectDir: args.projectDir });
  const mutation = addPluginId({ projectDir: args.projectDir, request, batch: { registry } }, source);
  if (policyAction) {mutation.policyAction = policyAction;}
  return mutate(mutation);
}

/** Execute a declarative batch through one kernel mutation call. */
export async function executeBatch(args = {}) {
  assertArgumentsObject(args);
  const { projectDir, actor, source } = args;
  validateArguments({ projectDir, actor, operation: "core.batch", source });
  const registry = resolveRegistry(source);
  const mutate = resolveMutation(source);
  return batchMutation({ args, registry, mutate, source });
}

export default executeOperation;
