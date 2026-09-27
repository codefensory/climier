// V1 plugin core surface (ADR-038 §Decision 9).
//
// `createCore({ projectDir, agent, pluginId })` returns
// `{ version: 1, run, batch }`. `run({ op, input })` and
// `batch({ if_state_revision, operations })` are mutation surfaces; batch is
// the SINGLE frontier for its complete declarative operation list.
// frontier for plugin-issued core actions: it validates the public plugin
// input and delegates execution to Application Operations, which looks up
// the canonical built-in registry and invokes the kernel once per op.
// The adapter is intentionally a thin mapper:
//   - no argv, no `commands/*`, no `readState`, no `withLock`,
//     no `updateState`, no `append`, and no registry ownership;
//   - actor and pluginId are fixed by the host (`createCore` args)
//     and cannot be overridden through `input.as` / `input._as`
//     (rejected before any state mutation);
//   - policy selection happens OUTSIDE the lock
//     (`loadApplicablePolicy`); policy decide happens INSIDE the lock
//     (Application Operations' mutation frontier);
//   - errors propagate with their structured envelopes:
//       * POLICY_*  (POLICY_DENIED / POLICY_ERROR / POLICY_CONFLICT)
//         surfaced verbatim — the kernel and the seam guarantee shape;
//       * PLUGIN_*  (PLUGIN_CORE_*, PLUGIN_HANDLER_FAILED, …) surfaced
//         verbatim — `isPluginError` short-circuits rewrap;
//       * anything else is wrapped via `wrapCoreError` into
//         PLUGIN_CORE_ACTION_FAILED with the cause envelope.
//
// The contract test (test/plugin-core-adapter.test.mjs) pins every
// behavior listed above and is the single source of truth for acceptance.
// The adapter preserves the established `{ node }` / `{ edge }` envelopes.

import {
  bootstrapBuiltins,
  executeOperation,
  executeBatch,
} from "../application/operations/index.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction, isPolicyError } from "./policy.mjs";
import {
  PluginCoreInvalidOperation,
  isPluginError,
  PolicyError,
  wrapCoreError,
} from "./errors.mjs";
import { assertLocalBackend } from "./remote-guard.mjs";

const REG = bootstrapBuiltins();

// Application Operations owns the built-in catalog. The adapter only keeps
// this process-local view to validate the public plugin operation list before
// any policy discovery or mutation.

function supportedOps() {
  // Return a fresh slice so callers cannot mutate the registry's
  // frozen `ops` array through the supported list.
  return REG.ops.slice();
}

// validateOp — op must be a non-empty string registered in the
// built-in registry. Anything else (undefined, null, number, unknown
// string) is the same "unknown operation" branch; the rejection
// happens before any state mutation and carries the full supported
// list so callers can recover without scanning the source.
function validateOp(pluginId, op) {
  if (typeof op !== "string" || !op) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      typeof op === "string" ? op : "",
      supportedOps(),
      "unknown operation",
    );
  }
  if (!REG.has(op)) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "unknown operation",
    );
  }
}

// validateInput — input must be a non-null, non-array object;
// `as` / `_as` are forbidden because the actor is fixed by the host
// (api.runtime.agent) and must never be substituted through plugin
// input.
function validateInput(pluginId, op, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "input must be an object",
    );
  }
  if ("as" in input || "_as" in input) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "input.as is forbidden",
    );
  }
}

function invalidBatch(pluginId, reason) {
  throw new PluginCoreInvalidOperation(pluginId, "core.batch", supportedOps(), reason);
}

const FORBIDDEN_BATCH_INPUT_KEYS = [
  "actor", "pluginId", "plugin_id", "handler", "argv", "as", "_as", "if_state_revision",
];

function assertBatchOperationObject(pluginId, operation, index) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    invalidBatch(pluginId, `operations[${index}] must be an object`);
  }
}

function assertBatchOperationKeys(pluginId, operation, index) {
  if (Object.keys(operation).some((key) => key !== "op" && key !== "input")) {
    invalidBatch(pluginId, `operations[${index}] accepts only op and input`);
  }
}

function assertBatchOperationFields(pluginId, operation, index) {
  if (typeof operation.op !== "string" || operation.op.length === 0) {
    invalidBatch(pluginId, `operations[${index}].op is required`);
  }
  if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
    invalidBatch(pluginId, `operations[${index}].input must be an object`);
  }
}

function validateBatchOperationShape(pluginId, operation, index) {
  assertBatchOperationObject(pluginId, operation, index);
  assertBatchOperationKeys(pluginId, operation, index);
  assertBatchOperationFields(pluginId, operation, index);
}

function validateBatchOperation(pluginId, operation, index) {
  validateBatchOperationShape(pluginId, operation, index);
  for (const key of FORBIDDEN_BATCH_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(operation.input, key)) {
      invalidBatch(pluginId, `operations[${index}].input.${key} is not allowed`);
    }
  }
}

// validateBatchInput — the host owns actor/plugin identity and the global
// CAS; entries can only be `{ op, input }` declarative operations.
function validateBatchFields(pluginId, input) {
  const unsupportedKey = Object.keys(input).find(
    (key) => key !== "if_state_revision" && key !== "operations",
  );
  if (unsupportedKey) {
    invalidBatch(pluginId, `input.${unsupportedKey} is not allowed`);
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    invalidBatch(pluginId, "operations must be a non-empty array");
  }
}

function validateBatchShape(pluginId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalidBatch(pluginId, "input must be an object");
  }
  validateBatchFields(pluginId, input);
}

function validateBatchInput(pluginId, input) {
  validateBatchShape(pluginId, input);
  input.operations.forEach((operation, index) => validateBatchOperation(pluginId, operation, index));
}

// selectPolicy — load the applicable policy outside the lock and
// normalize its errors. `loadApplicablePolicy` throws
// `PolicyError(action="applies")` when the policy's `applies()`
// raises; the adapter re-wraps that error with the caller's op id
// (`task.create`, `task.update`, …) so POLICY_ERROR surfaces with
// `details.action === <op>`, matching the contract pinned by the
// adapter tests. Any other error propagates unchanged.
async function selectPolicy({ projectDir, op, _pluginId }) {
  let policy;
  try {
    policy = await loadApplicablePolicy({ projectDir });
  } catch (err) {
    if (
      isPolicyError(err) &&
      err.code === "POLICY_ERROR" &&
      err.details &&
      err.details.action === "applies"
    ) {
      throw new PolicyError(
        err.details.plugin_id || "(unknown)",
        op,
        err,
      );
    }
    throw err;
  }
  return policy;
}

/**
 * createCore — exposes `api.core` as `{ version: 1, run, batch }`.
 *
 * @param {object} args
 * @param {string} args.projectDir - Project directory (the same
 *   directory the bin resolves; the lock and state files live under
 *   `$CLIMIER_HOME/projects/<project_id>/` keyed by `.climier.json`).
 * @param {string} args.agent - Host agent identity; every mutation
 *   is stamped with this actor and overrides any `input.as`.
 * @param {string} args.pluginId - Host plugin id; tagged on log
 *   entries via `plugin_id`; cannot be substituted by input.
 *
 * @returns {{ version: 1, run: function, batch: function }}
 */
function validateCoreArguments(projectDir, pluginId, backendClient) {
  assertLocalBackend(backendClient, "createCore");
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createCore: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createCore: pluginId required");
  }
}

async function runCoreOperation({ projectDir, agent, pluginId }, { op, input } = {}) {
  validateOp(pluginId, op);
  validateInput(pluginId, op, input);
  const policy = await selectPolicy({ projectDir, op, pluginId });
  try {
    return await executeOperation({
      projectDir,
      actor: agent,
      operation: op,
      input,
      source: {
        registry: REG,
        mutate,
        selectPolicy: async () => policy,
        authorizeAction,
        pluginId,
      },
    });
  } catch (err) {
    if (isPolicyError(err) || isPluginError(err)) {
      throw err;
    }
    throw wrapCoreError(pluginId, op, err);
  }
}

async function runCoreBatch({ projectDir, agent, pluginId }, input = {}) {
  validateBatchInput(pluginId, input);
  const policy = await selectPolicy({ projectDir, op: "core.batch", pluginId });
  try {
    return await executeBatch({
      projectDir,
      actor: agent,
      if_state_revision: input.if_state_revision,
      operations: input.operations,
      source: {
        registry: REG,
        mutate,
        selectPolicy: async () => policy,
        authorizeAction,
        pluginId,
      },
    });
  } catch (err) {
    if (isPolicyError(err) || isPluginError(err)) {
      throw err;
    }
    throw wrapCoreError(pluginId, "core.batch", err);
  }
}

export function createCore({ projectDir, agent, pluginId, backendClient }) {
  validateCoreArguments(projectDir, pluginId, backendClient);
  const identity = { projectDir, agent, pluginId };
  return {
    version: 1,

    /**
     * run — the single mutation frontier for plugin core actions.
     *
     * @param {object} args
     * @param {string} args.op - One of the 18 op ids in `bootstrapBuiltins()`.
     * @param {object} args.input - Typed input; shape per provider.
     *   `as` / `_as` are forbidden.
     *
     * @returns {Promise<{
     *   result: any,
     *   effects: object|null,
     *   log_entry: object|null,
     *   idempotent: boolean,
     *   diff: {
     *     created: { id, node }[],
     *     updated: { id, node }[],
     *     added_edges: Edge[],
     *     removed_edges: Edge[],
     *     removed_nodes: string[],
     *     target_revision: number|null,
     *     initiatives: { created: { name, initiative }[], updated: { name, initiative, previous }[] },
     *   },
     * }>}
     */
    run(args = {}) {
      return runCoreOperation(identity, args);
    },

    /**
     * batch — execute a declarative list of built-in operations in one
     * kernel mutation. The actor and plugin id are always taken from this
     * host-bound adapter; neither can be supplied by a batch entry.
     */
    batch(input = {}) {
      return runCoreBatch(identity, input);
    },
  };
}
