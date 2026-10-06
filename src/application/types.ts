import type {
  AuthorizeAction,
  LoadPolicy,
  MutateFn,
  Mutation,
  OperationRegistry,
  OperationSource,
  PolicyAction,
  Provider,
} from "../contracts/operations.ts";

export type ProjectConfig = Record<string, unknown> & {
  project_id?: string;
  backend?: BackendMetadata;
};

export type BackendMetadata = Record<string, unknown> & {
  type?: unknown;
  url?: unknown;
  protocol?: unknown;
};

export type LocalBackend = { type: "local" };
export type RemoteBackend = { type: "remote"; url: string; insecureRemoteHttp?: boolean };
export type BackendSelection = LocalBackend | RemoteBackend;

export type OperationCall = {
  actor?: unknown;
  operation?: unknown;
  input?: unknown;
  operations?: unknown;
  if_state_revision?: unknown;
  if_revision?: unknown;
  policyActionFromPlan?: boolean;
};

export type SourceInput = Partial<OperationSource> & {
  kernel?: { mutate?: MutateFn };
  loadApplicablePolicy?: LoadPolicy;
  selectPolicy?: LoadPolicy;
  authorize?: AuthorizeAction;
};

export type ProviderEntry = {
  id: string;
  kind: "task" | "gate" | "knowledge" | "core";
  provider: Provider;
};

export type ApplicationMutation = Mutation;

export type RemoteRequest = (request: {
  method: string;
  route: string;
  body?: unknown;
}) => Promise<unknown>;

export interface BackendClient {
  [key: string]: unknown;
  type: "local" | "remote";
  executeOperation(args?: OperationCall): Promise<unknown>;
  executeBatch(args?: OperationCall): Promise<unknown>;
}

export interface RemoteTransferClient extends BackendClient {
  type: "remote";
  exportTransfer(): Promise<unknown>;
  importTransfer(options: {
    payload: unknown;
    actor: string;
    expected_remote_revision?: number;
    force?: boolean;
  }): Promise<unknown>;
}

export type CodedApplicationError = Error & {
  code?: string;
  details?: Record<string, unknown>;
  status?: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBackendMetadata(value: unknown): value is BackendMetadata {
  return isRecord(value);
}

export function isProjectConfig(value: unknown): value is ProjectConfig {
  return isRecord(value);
}
