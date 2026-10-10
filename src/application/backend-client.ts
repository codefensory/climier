import { parseBackendConfig } from "./backend-config.ts";
import path from "node:path";
import { normalizeProjectName } from "../contracts/project-name.ts";
import { executeBatch, executeOperation } from "./operations/execute.ts";
import { remoteV1Manifest } from "./operations/remote-v1-manifest.ts";
import { createCredentialStore } from "../storage/credential-profile.ts";
import { createLocalOperationSource } from "./local-operation-source.ts";
import { createRemoteReadMethods } from "./backend-remote-reads.ts";
import { createRemoteRequest, REMOTE_PROTOCOL_VERSION } from "./backend-remote-transport.ts";
import type {
  BackendClient,
  BackendSelection,
  CodedApplicationError,
  OperationCall,
  ProjectConfig,
  RemoteBackend,
  RemoteRequest,
  SourceInput,
} from "./types.ts";
import { isRecord } from "./types.ts";

type CredentialStore = ReturnType<typeof createCredentialStore>;
type TransferExport = { payload: Record<string, unknown>; revision: number };
type TransferImportOptions = {
  payload: unknown;
  actor: string;
  expected_remote_revision?: number;
  force?: boolean;
};

function createLocalBackendClient({ projectDir, source }: { projectDir: string; source?: SourceInput }): BackendClient {
  const getSource = createLocalOperationSource(source);
  const client = {
    type: "local" as const,
    async executeOperation(options: OperationCall = {}) {
      const { actor, operation, input } = options;
      return executeOperation({ projectDir, actor, operation, input, source: await getSource() });
    },
    async executeBatch(options: OperationCall = {}) {
      const { actor, operations, input, if_state_revision } = options;
      return executeBatch({ projectDir, actor, operations, input, if_state_revision, source: await getSource() });
    },
  };
  Object.defineProperty(client, "operationSource", { enumerable: false, get: getSource });
  return Object.freeze(client);
}

export { REMOTE_PROTOCOL_VERSION };
const DEFAULT_TIMEOUT_MS = 10_000;
const REMOTE_OPERATION_IDS: Set<string> = new Set(remoteV1Manifest.operations.map(({ id }) => id));
const REMOTE_BATCH_OPERATION_IDS: Set<string> = new Set(remoteV1Manifest.batch.eligibleOperationIds);

function clientError(code: string, message: string, details?: Record<string, unknown>): CodedApplicationError {
  const error = new Error(message) as CodedApplicationError;
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function unsupportedRemoteOperation(operation: string): CodedApplicationError {
  return clientError(
    "REMOTE_UNSUPPORTED_OPERATION",
    `application.backendClient: operation '${operation}' is not supported by remote protocol v${REMOTE_PROTOCOL_VERSION}`,
    { operation },
  );
}

function validateRemoteOperation(operation: unknown): asserts operation is string {
  if (typeof operation !== "string" || !REMOTE_OPERATION_IDS.has(operation)) {
    throw unsupportedRemoteOperation(String(operation));
  }
}

function validateRemoteBatch(operations: unknown): void {
  if (!Array.isArray(operations)) {return;}
  for (const entry of operations) {
    if (!isRecord(entry) || typeof entry.op !== "string") {continue;}
    if (!REMOTE_BATCH_OPERATION_IDS.has(entry.op)) {throw unsupportedRemoteOperation(entry.op);}
  }
}

function validateTransferExport(result: unknown): TransferExport {
  if (!isRecord(result) || !isRecord(result.payload)
      || typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 0) {
    throw clientError(
      "REMOTE_INVALID_RESPONSE",
      "application.backendClient: transfer export response must contain an object payload and non-negative integer revision",
      { field: "result" },
    );
  }
  return { payload: result.payload, revision: result.revision };
}

type RemoteOperations = {
  executeOperation(options?: OperationCall): Promise<unknown>;
  executeBatch(options?: OperationCall): Promise<unknown>;
  init(): Promise<unknown>;
  renameProject(name: string): Promise<unknown>;
  exportTransfer(): Promise<TransferExport>;
  importTransfer(options: TransferImportOptions): Promise<unknown>;
};

function createRemoteOperations(request: RemoteRequest, { projectName }: { projectName?: string } = {}): RemoteOperations {
  return {
    async executeOperation(options: OperationCall = {}) {
      validateRemoteOperation(options.operation);
      return request({ method: "POST", route: "operations", body: { operation: options.operation, actor: options.actor, input: options.input } });
    },
    async executeBatch(options: OperationCall = {}) {
      validateRemoteBatch(options.operations);
      const input: { operations: unknown; if_state_revision?: unknown } = { operations: options.operations };
      if (options.if_state_revision !== undefined) {input.if_state_revision = options.if_state_revision;}
      return request({ method: "POST", route: "operations", body: { operation: "core.batch", actor: options.actor, input } });
    },
    init() {
      return request({ method: "POST", route: "init", body: projectName === undefined ? {} : { name: projectName } });
    },
    renameProject(name: string) {
      return request({ method: "POST", route: "rename", body: { name } });
    },
    async exportTransfer() {
      return validateTransferExport(await request({ method: "GET", route: "transfer/export" }));
    },
    async importTransfer(options: TransferImportOptions) {
      const body: TransferImportOptions = { payload: options.payload, actor: options.actor };
      if (options.force !== true && options.expected_remote_revision !== undefined) {body.expected_remote_revision = options.expected_remote_revision;}
      if (options.force !== undefined) {body.force = options.force;}
      return request({ method: "POST", route: "transfer/import", body });
    },
  };
}

function createRemoteTransport(options: {
  backend: RemoteBackend;
  projectId: string;
  projectName?: string;
  tokenProvider: (origin: string) => Promise<string | null>;
  timeoutMs: number;
}): RemoteOperations & ReturnType<typeof createRemoteReadMethods> {
  const request = createRemoteRequest(options);
  return Object.freeze({
    ...createRemoteOperations(request, { projectName: options.projectName }),
    ...createRemoteReadMethods(request),
  });
}

function validateBackendClientOptions(projectDir: unknown, timeoutMs: unknown): { projectDir: string; timeoutMs: number } {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: projectDir is required", { field: "projectDir" });
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: timeoutMs must be a positive integer", { field: "timeoutMs" });
  }
  return { projectDir, timeoutMs };
}

function validateRemoteClientOptions(projectConfig: ProjectConfig): string {
  if (typeof projectConfig.project_id !== "string" || projectConfig.project_id.length === 0) {
    throw clientError("REMOTE_PROJECT_ID_REQUIRED", "application.backendClient: remote backend requires project_id", { field: "project_id" });
  }
  return projectConfig.project_id;
}

function createSelectedBackendClient({
  backend,
  projectDir,
  projectConfig,
  source,
  credentialStore,
  timeoutMs,
}: {
  backend: BackendSelection;
  projectDir: string;
  projectConfig: ProjectConfig;
  source?: SourceInput;
  credentialStore: CredentialStore;
  timeoutMs: number;
}): BackendClient & Record<string, unknown> {
  if (backend.type === "local") {return createLocalBackendClient({ projectDir, source });}
  const projectId = validateRemoteClientOptions(projectConfig);
  const projectName = normalizeProjectName(projectConfig.name) ?? path.basename(path.resolve(projectDir));
  const transport = createRemoteTransport({
    backend,
    projectId,
    projectName,
    tokenProvider: async (origin) => {
      const token = await credentialStore.get(origin);
      return typeof token === "string" ? token : null;
    },
    timeoutMs,
  });
  return Object.freeze({ type: "remote" as const, insecureRemoteHttp: backend.insecureRemoteHttp === true, ...transport });
}

/** Create one backend selection for a project; remote failures never retry locally. */
export function createBackendClient({
  projectDir,
  projectConfig = {},
  source,
  command,
  credentialStore = createCredentialStore(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  projectDir?: unknown;
  projectConfig?: ProjectConfig;
  source?: SourceInput;
  command?: string;
  credentialStore?: CredentialStore;
  timeoutMs?: unknown;
} = {}): BackendClient & Record<string, unknown> {
  const validated = validateBackendClientOptions(projectDir, timeoutMs);
  const backend = parseBackendConfig(projectConfig, { command });
  return createSelectedBackendClient({
    backend,
    projectDir: validated.projectDir,
    projectConfig,
    source,
    credentialStore,
    timeoutMs: validated.timeoutMs,
  });
}

export default createBackendClient;
