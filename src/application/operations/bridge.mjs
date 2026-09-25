import {
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "./builtins.mjs";

/** Immutable allowlist of built-in operation IDs accepted by the project bridge. */
export const SUPPORTED_OPERATION_IDS = Object.freeze([
  ...PUBLIC_TASK_OPS,
  ...PUBLIC_GATE_OPS,
  ...PUBLIC_KNOWLEDGE_OPS,
  ...PUBLIC_CORE_OPS,
  "core.batch",
]);

const SUPPORTED_OPERATIONS = new Set(SUPPORTED_OPERATION_IDS.filter((id) => id !== "core.batch"));

function unsupportedOperation(operation) {
  const error = new Error(`application.operationBridge: operation '${operation}' is not supported by the project bridge`);
  error.code = "REMOTE_UNSUPPORTED_OPERATION";
  error.details = { operation };
  return error;
}

function validateBackendClient(backendClient) {
  if (!backendClient || typeof backendClient !== "object" ||
      !["local", "remote"].includes(backendClient.type) ||
      typeof backendClient.executeOperation !== "function" ||
      typeof backendClient.executeBatch !== "function") {
    const error = new Error("application.operationBridge: backendClient must provide local or remote operation execution");
    error.code = "INVALID_OPERATION_BRIDGE";
    throw error;
  }
}

/**
 * Select one project backend for all built-in write operations. The bridge
 * performs no policy, plugin, metadata, kernel, or storage work itself.
 */
export function createOperationBridge({ backendClient } = {}) {
  validateBackendClient(backendClient);
  return Object.freeze({
    type: backendClient.type,
    async executeOperation(args = {}) {
      if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.operation !== "string") {
        const error = new Error("application.operationBridge: operation id is required");
        error.code = "INVALID_OPERATION_BRIDGE";
        error.details = { field: "operation" };
        throw error;
      }
      if (!SUPPORTED_OPERATIONS.has(args.operation)) throw unsupportedOperation(args.operation);
      return await backendClient.executeOperation(args);
    },
    async executeBatch(args = {}) {
      return await backendClient.executeBatch(args);
    },
  });
}

export default createOperationBridge;
