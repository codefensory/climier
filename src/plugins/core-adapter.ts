
import {
  bootstrapBuiltins,
  executeOperation,
  executeBatch,
} from "../application/operations/index.ts";
import { mutate } from "../kernel/mutate.ts";
import { loadApplicablePolicy, authorizeAction, isPolicyError } from "./policy.ts";
import {
  PluginCoreInvalidOperation,
  isPluginError,
  PolicyError,
  wrapCoreError,
} from "./errors.ts";
import { assertLocalBackend } from "./remote-guard.ts";

const REG = bootstrapBuiltins();

function supportedOps() {

  return REG.ops.slice();
}

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

    run(args = {}) {
      return runCoreOperation(identity, args);
    },

    batch(input = {}) {
      return runCoreBatch(identity, input);
    },
  };
}
