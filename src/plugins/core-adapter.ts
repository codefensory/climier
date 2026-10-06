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
import type { PluginBackendClient, PluginCore } from "./types.ts";
import { isRecord } from "../application/types.ts";

const REG = bootstrapBuiltins();
type CoreIdentity = { projectDir: string; agent: unknown; pluginId: string };
type BatchInput = { operations: unknown[]; if_state_revision?: unknown };

type OperationInput = Record<string, unknown>;

function supportedOps(): readonly string[] {
  return REG.ops.slice();
}

function validateOp(pluginId: string, op: unknown): asserts op is string {
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

function validateInput(pluginId: string, op: string, input: unknown): asserts input is OperationInput {
  if (!isRecord(input)) {
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

function invalidBatch(pluginId: string, reason: string): never {
  throw new PluginCoreInvalidOperation(pluginId, "core.batch", supportedOps(), reason);
}

const FORBIDDEN_BATCH_INPUT_KEYS = [
  "actor", "pluginId", "plugin_id", "handler", "argv", "as", "_as", "if_state_revision",
];

function assertBatchOperationObject(pluginId: string, operation: unknown, index: number): asserts operation is OperationInput {
  if (!isRecord(operation)) {
    invalidBatch(pluginId, `operations[${index}] must be an object`);
  }
}

function assertBatchOperationKeys(pluginId: string, operation: OperationInput, index: number): void {
  if (Object.keys(operation).some((key) => key !== "op" && key !== "input")) {
    invalidBatch(pluginId, `operations[${index}] accepts only op and input`);
  }
}

function assertBatchOperationFields(pluginId: string, operation: OperationInput, index: number): asserts operation is OperationInput & { op: string; input: OperationInput } {
  if (typeof operation.op !== "string" || operation.op.length === 0) {
    invalidBatch(pluginId, `operations[${index}].op is required`);
  }
  if (!isRecord(operation.input)) {
    invalidBatch(pluginId, `operations[${index}].input must be an object`);
  }
}

function validateBatchOperation(pluginId: string, operation: unknown, index: number): void {
  assertBatchOperationObject(pluginId, operation, index);
  assertBatchOperationKeys(pluginId, operation, index);
  assertBatchOperationFields(pluginId, operation, index);
  for (const key of FORBIDDEN_BATCH_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(operation.input, key)) {
      invalidBatch(pluginId, `operations[${index}].input.${key} is not allowed`);
    }
  }
}

// CAS; entries can only be `{ op, input }` declarative operations.
function validateBatchFields(pluginId: string, input: OperationInput): asserts input is OperationInput & BatchInput {
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

function validateBatchInput(pluginId: string, input: unknown): asserts input is BatchInput {
  if (!isRecord(input)) {
    invalidBatch(pluginId, "input must be an object");
  }
  validateBatchFields(pluginId, input);
  input.operations.forEach((operation, index) => validateBatchOperation(pluginId, operation, index));
}

async function selectPolicy({ projectDir, op, _pluginId }: { projectDir: string; op: string; _pluginId?: string }) {
  let policy;
  try {
    policy = await loadApplicablePolicy({ projectDir });
  } catch (err: unknown) {
    if (
      isPolicyError(err) &&
      err.code === "POLICY_ERROR" &&
      isRecord(err.details) &&
      err.details.action === "applies"
    ) {
      throw new PolicyError(
        typeof err.details.plugin_id === "string" ? err.details.plugin_id : "(unknown)",
        op,
        err,
      );
    }
    throw err;
  }
  return policy;
}

function validateCoreArguments(projectDir: unknown, pluginId: unknown, backendClient: unknown): { projectDir: string; pluginId: string } {
  assertLocalBackend(backendClient, "createCore");
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createCore: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createCore: pluginId required");
  }
  return { projectDir, pluginId };
}

async function runCoreOperation({ projectDir, agent, pluginId }: CoreIdentity, { op, input }: { op?: unknown; input?: unknown } = {}): Promise<unknown> {
  validateOp(pluginId, op);
  validateInput(pluginId, op, input);
  const policy = await selectPolicy({ projectDir, op, _pluginId: pluginId });
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
  } catch (err: unknown) {
    if (isPolicyError(err) || isPluginError(err)) {
      throw err;
    }
    throw wrapCoreError(pluginId, op, err);
  }
}

async function runCoreBatch({ projectDir, agent, pluginId }: CoreIdentity, input: unknown = {}): Promise<unknown> {
  validateBatchInput(pluginId, input);
  const policy = await selectPolicy({ projectDir, op: "core.batch", _pluginId: pluginId });
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
  } catch (err: unknown) {
    if (isPolicyError(err) || isPluginError(err)) {
      throw err;
    }
    throw wrapCoreError(pluginId, "core.batch", err);
  }
}

export function createCore({ projectDir, agent, pluginId, backendClient }: {
  projectDir: unknown;
  agent: unknown;
  pluginId: unknown;
  backendClient: PluginBackendClient;
}): PluginCore {
  const validated = validateCoreArguments(projectDir, pluginId, backendClient);
  const identity: CoreIdentity = { projectDir: validated.projectDir, agent, pluginId: validated.pluginId };
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
