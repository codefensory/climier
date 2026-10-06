import { throwV2 } from "../../contracts/errors.ts";
import type {
  AuthorizeAction,
  LoadPolicy,
  MutateFn,
  Mutation,
  OperationRegistry,
  OperationRequest,
  Policy,
  PolicyAction,
  PolicyContext,
  Provider,
} from "../../contracts/operations.ts";
import type { SourceInput } from "../types.ts";
import { isRecord } from "../types.ts";

type ExecutionArgs = {
  projectDir?: unknown;
  actor?: unknown;
  operation?: unknown;
  input?: unknown;
  source?: unknown;
  operations?: unknown;
  if_state_revision?: unknown;
  policyActionFromPlan?: boolean;
};

type ValidExecutionArgs = {
  projectDir: string;
  actor: string;
  operation: string;
  input: unknown;
  source: SourceInput;
  policyActionFromPlan?: boolean;
};

type Dependencies = ValidExecutionArgs & {
  registry: OperationRegistry;
  mutate: MutateFn;
  provider: Provider;
};

function contractError(message: string, field: string, details: Record<string, unknown> = {}): never {
  throwV2("INVALID_EXECUTION_CONTRACT", `application.executeOperation: ${message}`, { field, ...details });
}

function validateProjectDir(projectDir: unknown): asserts projectDir is string {
  if (typeof projectDir !== "string" || projectDir.length === 0) {contractError("projectDir is required", "projectDir");}
}

function validateActor(actor: unknown): asserts actor is string {
  if (typeof actor !== "string" || actor.length === 0) {contractError("actor is required", "actor");}
}

function validateOperation(operation: unknown): asserts operation is string {
  if (typeof operation !== "string" || operation.length === 0) {contractError("operation is required", "operation");}
}

function validateSource(source: unknown): asserts source is SourceInput {
  if (!isRecord(source)) {contractError("source is required", "source");}
}

function validateArguments(args: {
  projectDir: unknown;
  actor: unknown;
  operation: unknown;
  source: unknown;
}): asserts args is {
  projectDir: string;
  actor: string;
  operation: string;
  source: SourceInput;
} {
  validateProjectDir(args.projectDir);
  validateActor(args.actor);
  validateOperation(args.operation);
  validateSource(args.source);
}

function resolveMutation(source: SourceInput): MutateFn {
  const kernelMutate = source.kernel && typeof source.kernel.mutate === "function" ? source.kernel.mutate : null;
  const mutate = typeof source.mutate === "function" ? source.mutate : kernelMutate;
  if (!mutate) {contractError("source.mutate must be a function", "source.mutate");}
  return mutate;
}

function resolveRegistry(source: SourceInput): OperationRegistry {
  if (!source.registry || typeof source.registry !== "object" || typeof source.registry.lookup !== "function") {
    contractError("source.registry.lookup must be a function", "source.registry.lookup");
  }
  return source.registry;
}

function resolveProvider(registry: OperationRegistry, operation: string): Provider {
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

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function addRevisionPreconditions(request: OperationRequest, input: unknown): void {
  if (!isInputRecord(input)) {return;}
  if (Object.prototype.hasOwnProperty.call(input, "if_state_revision")) {
    request.if_state_revision = input.if_state_revision as number;
  }
  const ifRevision = input.if_revision;
  if (typeof input.id === "string" && input.id.length > 0 && typeof ifRevision === "number" && Number.isInteger(ifRevision) && ifRevision >= 1) {
    request.if_revision = { kind: "single", id: input.id, value: ifRevision };
    return;
  }
  if (isRecord(input.if_revisions)) {
    request.if_revision = { kind: "multi", values: input.if_revisions as Record<string, number> };
  }
}

function buildRequest({ operation, actor, input }: ValidExecutionArgs): OperationRequest {
  const request: OperationRequest = { action: operation, actor, input };
  addRevisionPreconditions(request, input);
  return request;
}

function resolvePolicySelector(source: SourceInput): LoadPolicy | null {
  if (typeof source.selectPolicy === "function") {return source.selectPolicy;}
  if (typeof source.loadApplicablePolicy === "function") {return source.loadApplicablePolicy;}
  return null;
}

function resolveAuthorizer(source: SourceInput): AuthorizeAction | null {
  if (typeof source.authorizeAction === "function") {return source.authorizeAction;}
  if (typeof source.authorize === "function") {return source.authorize;}
  return null;
}

function abstainPolicyAction(operation: string): PolicyAction {
  return { action: operation, async decide() { return { decision: "abstain" }; } };
}

function policyDecision({ policy, operation, projectDir, authorizeAction }: {
  policy: Policy;
  operation: string;
  projectDir: string;
  authorizeAction: AuthorizeAction;
}): PolicyAction {
  return {
    action: operation,
    pluginId: policy.pluginId || null,
    async decide(args: PolicyContext) {
      const extendedArgs = args as PolicyContext & { request?: OperationRequest };
      return authorizeAction({
        policy,
        action: extendedArgs.action || operation,
        actor: extendedArgs.request ? extendedArgs.request.actor : args.actor,
        target: args.target,
        snapshot: args.snapshot,
        projectDir,
        projectConfig: policy.projectConfig,
      });
    },
  };
}

async function buildPolicyAction({ source, projectDir, operation, policyActionFromPlan = false }: {
  source: SourceInput;
  projectDir: string;
  operation: string;
  policyActionFromPlan?: boolean;
}): Promise<PolicyAction | null> {
  const abstainAction = policyActionFromPlan ? abstainPolicyAction(operation) : null;
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) {return abstainAction;}
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) {return abstainAction;}
  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");}
  return policyDecision({ policy, operation, projectDir, authorizeAction });
}

async function buildBatchPolicyAction({ source, projectDir }: { source: SourceInput; projectDir: string }): Promise<PolicyAction | null> {
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) {return null;}
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) {return null;}
  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");}
  return {
    pluginId: policy.pluginId || null,
    async decide(args: PolicyContext) {
      return authorizeAction({ policy, action: args.action, actor: args.actor, target: args.target, snapshot: args.snapshot, projectDir, projectConfig: policy.projectConfig });
    },
  };
}

function addPluginId(mutation: Mutation, source: SourceInput): Mutation {
  if (typeof source.pluginId === "string" && source.pluginId.length > 0) {mutation.pluginId = source.pluginId;}
  return mutation;
}

function singleMutation({ projectDir, request, provider, policyAction, policyActionFromPlan, source }: {
  projectDir: string;
  request: OperationRequest;
  provider: Provider;
  policyAction: PolicyAction | null;
  policyActionFromPlan?: boolean;
  source: SourceInput;
}): Mutation {
  const mutation: Mutation = { projectDir, request, provider };
  if (policyActionFromPlan === true) {mutation.policyActionFromPlan = true;}
  if (policyAction) {mutation.policyAction = policyAction;}
  return addPluginId(mutation, source);
}

async function mutateOperation(mutate: MutateFn, mutation: Mutation, policyActionFromPlan: boolean): Promise<unknown> {
  try {
    return await mutate(mutation);
  } catch (error: unknown) {
    if (policyActionFromPlan === true && error instanceof Error && error.code === "POLICY_TAKEOVER_ABSTAIN") {
      throwV2("ALREADY_CLAIMED", error.message, error.details);
    }
    throw error;
  }
}

function assertArgumentsObject(args: unknown): asserts args is ExecutionArgs {
  if (!isRecord(args)) {contractError("arguments must be an object", "arguments");}
}

function operationDependencies(args: ExecutionArgs): Dependencies {
  const candidate = { projectDir: args.projectDir, actor: args.actor, operation: args.operation, source: args.source };
  validateArguments(candidate);
  const registry = resolveRegistry(candidate.source);
  const mutate = resolveMutation(candidate.source);
  const provider = resolveProvider(registry, candidate.operation);
  return { ...candidate, input: args.input, policyActionFromPlan: args.policyActionFromPlan, registry, mutate, provider };
}

/**
 * Compose one registered operation and delegate it once to the kernel.
 * The caller supplies the registry, mutation frontier, and optional policy source.
 */
export async function executeOperation(args: ExecutionArgs = {}): Promise<unknown> {
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
  return mutateOperation(dependencies.mutate, mutation, args.policyActionFromPlan === true);
}

function batchInput(args: ValidExecutionArgs & Pick<ExecutionArgs, "operations" | "if_state_revision">): OperationRequest {
  const input = isRecord(args.input) ? args.input : { operations: args.operations };
  const operations = args.operations === undefined ? input.operations : args.operations;
  const expectedRevision = args.if_state_revision === undefined ? input.if_state_revision : args.if_state_revision;
  const request: OperationRequest = { action: "core.batch", actor: args.actor, input: { operations } };
  if (expectedRevision !== undefined) {request.if_state_revision = expectedRevision as number;}
  return request;
}

async function batchMutation({ args, registry, mutate, source }: {
  args: ValidExecutionArgs & Pick<ExecutionArgs, "operations" | "if_state_revision">;
  registry: OperationRegistry;
  mutate: MutateFn;
  source: SourceInput;
}): Promise<unknown> {
  const request = batchInput(args);
  const policyAction = await buildBatchPolicyAction({ source, projectDir: args.projectDir });
  const mutation: Mutation = addPluginId({ projectDir: args.projectDir, request, batch: { registry } }, source);
  if (policyAction) {mutation.policyAction = policyAction;}
  return mutate(mutation);
}

export async function executeBatch(args: ExecutionArgs = {}): Promise<unknown> {
  assertArgumentsObject(args);
  const candidate = {
    projectDir: args.projectDir,
    actor: args.actor,
    operation: "core.batch",
    source: args.source,
  };
  validateArguments(candidate);
  const registry = resolveRegistry(candidate.source);
  const mutate = resolveMutation(candidate.source);
  return batchMutation({ args: { ...candidate, input: args.input, policyActionFromPlan: args.policyActionFromPlan, operations: args.operations, if_state_revision: args.if_state_revision }, registry, mutate, source: candidate.source });
}

export default executeOperation;
