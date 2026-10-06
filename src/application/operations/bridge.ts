import {
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "./builtins.ts";
import type { BackendClient, OperationCall } from "../types.ts";
import { isRecord } from "../types.ts";

/** Immutable allowlist of built-in operation IDs accepted by the project bridge. */
export const SUPPORTED_OPERATION_IDS = Object.freeze([
  ...PUBLIC_TASK_OPS,
  ...PUBLIC_GATE_OPS,
  ...PUBLIC_KNOWLEDGE_OPS,
  ...PUBLIC_CORE_OPS,
  "core.batch",
]);

const SUPPORTED_OPERATIONS: ReadonlySet<string> = new Set(SUPPORTED_OPERATION_IDS.filter((id) => id !== "core.batch"));

function unsupportedOperation(operation: string): Error {
  const error = new Error(`application.operationBridge: operation '${operation}' is not supported by the project bridge`);
  error.code = "REMOTE_UNSUPPORTED_OPERATION";
  error.details = { operation };
  return error;
}

function validateBackendClient(backendClient: unknown): asserts backendClient is BackendClient {
  if (!isRecord(backendClient) || !["local", "remote"].includes(backendClient.type as string)
      || typeof backendClient.executeOperation !== "function"
      || typeof backendClient.executeBatch !== "function") {
    const error = new Error("application.operationBridge: backendClient must provide local or remote operation execution");
    error.code = "INVALID_OPERATION_BRIDGE";
    throw error;
  }
}

export function createOperationBridge({ backendClient }: { backendClient?: unknown } = {}): {
  type: "local" | "remote";
  executeOperation(args?: OperationCall): Promise<unknown>;
  executeBatch(args?: OperationCall): Promise<unknown>;
} {
  validateBackendClient(backendClient);
  return Object.freeze({
    type: backendClient.type,
    async executeOperation(args: OperationCall = {}) {
      if (!isRecord(args) || typeof args.operation !== "string") {
        const error = new Error("application.operationBridge: operation id is required");
        error.code = "INVALID_OPERATION_BRIDGE";
        error.details = { field: "operation" };
        throw error;
      }
      if (!SUPPORTED_OPERATIONS.has(args.operation)) {throw unsupportedOperation(args.operation);}
      return await backendClient.executeOperation(args);
    },
    async executeBatch(args: OperationCall = {}) {
      return await backendClient.executeBatch(args);
    },
  });
}

export default createOperationBridge;
