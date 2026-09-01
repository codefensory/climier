// Application-level composition for registered operations.
//
// This boundary deliberately receives its registry and mutation frontier from
// `source`. It does not import the kernel, providers, adapters, or lifecycle
// rules. Hosts can therefore assemble the same operation execution from the
// CLI, plugin, or a test without making those consumers depend on kernel
// modules directly.

import { throwV2 } from "../../contracts/errors.mjs";

function contractError(message, field, details = {}) {
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `application.executeOperation: ${message}`,
    { field, ...details },
  );
}

function validateArguments({ projectDir, actor, operation, source } = {}) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    contractError("projectDir is required", "projectDir");
  }
  if (typeof actor !== "string" || actor.length === 0) {
    contractError("actor is required", "actor");
  }
  if (typeof operation !== "string" || operation.length === 0) {
    contractError("operation is required", "operation");
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    contractError("source is required", "source");
  }
}

function resolveMutation(source) {
  // `mutate` is the compact source contract. Accepting the explicit
  // `kernel.mutate` projection as well keeps the dependency boundary clear
  // for hosts that expose their kernel as a named object.
  const mutate = typeof source.mutate === "function"
    ? source.mutate
    : source.kernel && typeof source.kernel.mutate === "function"
      ? source.kernel.mutate
      : null;
  if (!mutate) {
    contractError("source.mutate must be a function", "source.mutate");
  }
  return mutate;
}

function resolveRegistry(source) {
  if (!source.registry || typeof source.registry !== "object" ||
      typeof source.registry.lookup !== "function") {
    contractError("source.registry.lookup must be a function", "source.registry.lookup");
  }
  return source.registry;
}

function resolveProvider(registry, operation) {
  // Do not catch lookup failures: registry-specific structured errors are
  // part of the operation source contract and must reach the adapter intact.
  const entry = registry.lookup(operation);
  if (!entry || typeof entry !== "object") {
    const error = new Error(`application.executeOperation: operation '${operation}' is not registered`);
    error.code = "OPERATION_NOT_FOUND";
    error.details = { operation };
    throw error;
  }
  const provider = entry.provider || entry;
  if (!provider || typeof provider !== "object" ||
      typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
    contractError(
      `registry entry for '${operation}' must provide prepare and apply functions`,
      "source.registry",
      { operation },
    );
  }
  return provider;
}

function buildRequest({ operation, actor, input }) {
  const request = { action: operation, actor, input };

  // Providers validate their typed input. The application boundary only
  // projects the generic CAS fields onto the kernel request so the kernel can
  // check them against the fresh snapshot under its lock.
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if (Object.prototype.hasOwnProperty.call(input, "if_state_revision")) {
      request.if_state_revision = input.if_state_revision;
    }
    if (typeof input.id === "string" && input.id.length > 0 &&
        Number.isInteger(input.if_revision) && input.if_revision >= 1) {
      request.if_revision = {
        kind: "single",
        id: input.id,
        value: input.if_revision,
      };
    } else if (input.if_revisions && typeof input.if_revisions === "object" &&
        !Array.isArray(input.if_revisions)) {
      request.if_revision = {
        kind: "multi",
        values: input.if_revisions,
      };
    }
  }
  return request;
}

function resolvePolicySelector(source) {
  if (typeof source.selectPolicy === "function") return source.selectPolicy;
  if (typeof source.loadApplicablePolicy === "function") return source.loadApplicablePolicy;
  return null;
}

function resolveAuthorizer(source) {
  if (typeof source.authorizeAction === "function") return source.authorizeAction;
  if (typeof source.authorize === "function") return source.authorize;
  return null;
}

async function buildPolicyAction({ source, projectDir, operation }) {
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) return null;

  // Selection is intentionally performed before the mutation frontier is
  // invoked. The selected policy is only represented as a callback for the
  // kernel; authorization remains the kernel's responsibility under lock.
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) return null;

  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {
    contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");
  }

  return {
    action: operation,
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return await authorizeAction({
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

async function buildBatchPolicyAction({ source, projectDir }) {
  const selectPolicy = resolvePolicySelector(source);
  if (!selectPolicy) return null;
  const policy = await selectPolicy({ projectDir });
  if (policy === null || policy === undefined) return null;
  const authorizeAction = resolveAuthorizer(source);
  if (!authorizeAction) {
    contractError("source.authorizeAction must be a function when a policy is selected", "source.authorizeAction");
  }
  return {
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return await authorizeAction({
        policy,
        action,
        actor: request.actor,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig,
      });
    },
  };
}

/**
 * Compose one registered operation and delegate it once to the kernel.
 *
 * @param {object} args
 * @param {string} args.projectDir project being mutated
 * @param {string} args.actor actor identity for the request
 * @param {string} args.operation registered operation id
 * @param {object|undefined} args.input provider input
 * @param {object} args.source explicit dependencies: `{ registry, mutate }`;
 *   `kernel.mutate`, policy selection, and authorization may be supplied as
 *   named projections for hosts that use those shapes.
 * @returns {Promise<object>} the kernel result, unchanged
 */
export async function executeOperation(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    contractError("arguments must be an object", "arguments");
  }
  const { projectDir, actor, operation, input, source } = args;
  validateArguments({ projectDir, actor, operation, source });
  const registry = resolveRegistry(source);
  const mutate = resolveMutation(source);
  const provider = resolveProvider(registry, operation);
  const request = buildRequest({ operation, actor, input });
  const policyAction = await buildPolicyAction({ source, projectDir, operation });

  const mutation = { projectDir, request, provider };
  if (policyAction) mutation.policyAction = policyAction;
  if (typeof source.pluginId === "string" && source.pluginId.length > 0) {
    mutation.pluginId = source.pluginId;
  }

  // Keep this as the sole call to the supplied mutation frontier. In
  // particular, application code does not retry, call lifecycle handlers, or
  // persist state itself.
  return await mutate(mutation);
}

/**
 * Execute a declarative batch through one kernel mutation call.
 * `operations` may be supplied directly or through `input`; the global CAS
 * is intentionally projected onto the outer request, never each operation.
 */
export async function executeBatch(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    contractError("arguments must be an object", "arguments");
  }
  const { projectDir, actor, source } = args;
  validateArguments({ projectDir, actor, operation: "core.batch", source });
  const registry = resolveRegistry(source);
  const mutate = resolveMutation(source);
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input)
    ? args.input
    : { operations: args.operations };
  const operations = args.operations === undefined ? input.operations : args.operations;
  const batchInput = { operations };
  const expectedRevision = args.if_state_revision === undefined
    ? input.if_state_revision
    : args.if_state_revision;
  const request = { action: "core.batch", actor, input: batchInput };
  if (expectedRevision !== undefined) request.if_state_revision = expectedRevision;
  const policyAction = await buildBatchPolicyAction({ source, projectDir });
  const mutation = {
    projectDir,
    request,
    batch: { registry },
  };
  if (policyAction) mutation.policyAction = policyAction;
  if (typeof source.pluginId === "string" && source.pluginId.length > 0) {
    mutation.pluginId = source.pluginId;
  }
  return await mutate(mutation);
}

export default executeOperation;
