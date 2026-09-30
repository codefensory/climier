import { parseBackendConfig } from "./backend-config.mjs";
import { executeBatch, executeOperation } from "./operations/execute.mjs";
import { remoteV2Manifest } from "./operations/remote-v2-manifest.mjs";
import { createCredentialStore } from "../storage/credential-profile.mjs";
import { createLocalOperationSource } from "./local-operation-source.mjs";
import { createRemoteReadMethods } from "./backend-remote-reads.mjs";
import { createRemoteRequest, REMOTE_PROTOCOL_VERSION } from "./backend-remote-transport.mjs";

function createLocalBackendClient({ projectDir, source }) {
  const getSource = createLocalOperationSource(source);
  const client = {
    type: "local",
    async executeOperation({ actor, operation, input } = {}) {
      return executeOperation({ projectDir, actor, operation, input, source: await getSource() });
    },
    async executeBatch({ actor, operations, input, if_state_revision } = {}) {
      return executeBatch({ projectDir, actor, operations, input, if_state_revision, source: await getSource() });
    },
  };
  Object.defineProperty(client, "operationSource", { enumerable: false, get: getSource });
  return Object.freeze(client);
}

export { REMOTE_PROTOCOL_VERSION };
const DEFAULT_TIMEOUT_MS = 10_000;
const REMOTE_OPERATION_IDS = new Set(remoteV2Manifest.operations.map(({ id }) => id));
const REMOTE_BATCH_OPERATION_IDS = new Set(remoteV2Manifest.batch.eligibleOperationIds);

function clientError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function unsupportedRemoteOperation(operation) {
  return clientError(
    "REMOTE_UNSUPPORTED_OPERATION",
    `application.backendClient: operation '${operation}' is not supported by remote protocol v${REMOTE_PROTOCOL_VERSION}`,
    { operation },
  );
}

function validateRemoteOperation(operation) {
  if (typeof operation !== "string" || !REMOTE_OPERATION_IDS.has(operation)) {
    throw unsupportedRemoteOperation(operation);
  }
}

function validateRemoteBatch(operations) {
  if (!Array.isArray(operations)) {return;}
  for (const entry of operations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.op !== "string") {continue;}
    if (!REMOTE_BATCH_OPERATION_IDS.has(entry.op)) {throw unsupportedRemoteOperation(entry.op);}
  }
}

function createRemoteOperations(request) {
  return {
    async executeOperation({ actor, operation, input } = {}) {
      validateRemoteOperation(operation);
      return request({ method: "POST", route: "operations", body: { operation, actor, input } });
    },
    async executeBatch({ actor, operations, if_state_revision } = {}) {
      validateRemoteBatch(operations);
      const input = { operations };
      if (if_state_revision !== undefined) {input.if_state_revision = if_state_revision;}
      return request({ method: "POST", route: "operations", body: { operation: "core.batch", actor, input } });
    },
    init() {
      return request({ method: "POST", route: "init", body: {} });
    },
  };
}

function createRemoteTransport(options) {
  const request = createRemoteRequest(options);
  return Object.freeze({
    ...createRemoteOperations(request),
    ...createRemoteReadMethods(request),
  });
}

function validateBackendClientOptions({ projectDir, timeoutMs }) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: projectDir is required", { field: "projectDir" });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: timeoutMs must be a positive integer", { field: "timeoutMs" });
  }
}

function validateRemoteClientOptions(projectConfig) {
  if (typeof projectConfig.project_id !== "string" || projectConfig.project_id.length === 0) {
    throw clientError("REMOTE_PROJECT_ID_REQUIRED", "application.backendClient: remote backend requires project_id", { field: "project_id" });
  }
}

function createSelectedBackendClient({ backend, projectDir, projectConfig, source, credentialStore, timeoutMs }) {
  if (backend.type === "local") {return createLocalBackendClient({ projectDir, source });}
  if (backend.insecureRemoteHttp === true) {
    throw clientError("REMOTE_INSECURE_ORIGIN", "application.backendClient: remote origin must use HTTPS outside localhost");
  }
  validateRemoteClientOptions(projectConfig);
  const transport = createRemoteTransport({
    backend,
    projectId: projectConfig.project_id,
    tokenProvider: (origin) => credentialStore.get(origin),
    timeoutMs,
  });
  return Object.freeze({ type: "remote", insecureRemoteHttp: backend.insecureRemoteHttp === true, ...transport });
}

/** Create one backend selection for a project; remote failures never retry locally. */
export function createBackendClient({
  projectDir,
  projectConfig = {},
  source,
  credentialStore = createCredentialStore(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  validateBackendClientOptions({ projectDir, timeoutMs });
  const backend = parseBackendConfig(projectConfig);
  return createSelectedBackendClient({ backend, projectDir, projectConfig, source, credentialStore, timeoutMs });
}

export default createBackendClient;
