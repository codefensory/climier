import { asCaughtError } from "../contracts/errors.ts";
import { parseBackendConfig } from "./backend-config.ts";
import { captureTransferSource, installTransferDestination } from "../kernel/transfer.ts";
import { createRemoteTransferBaselineStore } from "../storage/remote-transfer-baseline.ts";
import type { ProjectConfig, RemoteTransferClient, CodedApplicationError } from "./types.ts";
import { isRecord } from "./types.ts";

type Baseline = {
  version: 1;
  origin: string;
  project_id: string;
  remote_revision: number;
  local_revision: number;
};

type BaselineStore = {
  get(origin: string, projectId: string): Promise<Baseline | null>;
  set(value: Baseline): Promise<void>;
};

type ValidTransferRequest = {
  projectDir: string;
  projectConfig: ProjectConfig;
  backendClient: RemoteTransferClient;
  actor: string;
  force: boolean;
  origin: string;
  projectId: string;
};

type CapturedTransfer = { payload: Record<string, unknown>; revision: number };
type ImportOptions = {
  payload: unknown;
  actor: string;
  expected_remote_revision?: number;
  force?: boolean;
};
type InstallOptions = {
  destinationProjectDir: string;
  payload: Record<string, unknown>;
  actor: string;
  direction: "pull";
  force: boolean;
  expectedRevision?: number;
};

function transferError(code: string, message: string, details?: Record<string, unknown>, cause?: unknown): CodedApplicationError {
  const error = new Error(message, cause ? { cause } : undefined) as CodedApplicationError;
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function validateRequest(request: unknown): ValidTransferRequest {
  if (!isRecord(request)) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: request must be an object");
  }
  if (typeof request.projectDir !== "string" || !request.projectDir.trim()) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: projectDir is required", { field: "projectDir" });
  }
  if (!isRecord(request.projectConfig)) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: projectConfig must be an object", { field: "projectConfig" });
  }
  const projectConfig = request.projectConfig as ProjectConfig;
  if (typeof projectConfig.project_id !== "string" || !projectConfig.project_id.trim()) {
    throw transferError("REMOTE_PROJECT_ID_REQUIRED", "transfer: remote project_id is required", { field: "project_id" });
  }
  if (typeof request.actor !== "string" || !request.actor.trim()) {
    throw transferError("TRANSFER_ACTOR_REQUIRED", "transfer: actor is required", { field: "actor" });
  }
  if (typeof request.force !== "boolean") {
    throw transferError("TRANSFER_FORCE_INVALID", "transfer: force must be boolean", { field: "force" });
  }

  const backend = parseBackendConfig(projectConfig);
  if (backend.type !== "remote") {
    throw transferError("REMOTE_BACKEND_REQUIRED", "transfer: manual transfer requires a remote backend");
  }
  if (!isRecord(request.backendClient) || request.backendClient.type !== "remote") {
    throw transferError("REMOTE_BACKEND_REQUIRED", "transfer: a remote backend client is required");
  }
  if (typeof request.backendClient.exportTransfer !== "function"
      || typeof request.backendClient.importTransfer !== "function") {
    throw transferError("REMOTE_TRANSFER_UNSUPPORTED", "transfer: remote backend client must support transfer export and import");
  }

  return {
    projectDir: request.projectDir,
    projectConfig,
    backendClient: request.backendClient as unknown as RemoteTransferClient,
    actor: request.actor,
    force: request.force,
    origin: new URL(backend.url).origin,
    projectId: projectConfig.project_id,
  };
}

function validateRemoteRevision(revision: unknown, operation: string): asserts revision is number {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw transferError(
      "REMOTE_INVALID_RESPONSE",
      `transfer: remote ${operation} response must contain a non-negative integer revision`,
      { field: "revision" },
    );
  }
}

function translateLocalInstallError(error: unknown, expectedRevision: number | undefined, force: boolean): never {
  const caught = asCaughtError(error);
  if (caught.code === "CLIMIER_TRANSFER_REVISION_MISMATCH") {
    throw transferError(
      "TRANSFER_LOCAL_CHANGED",
      "transfer: local state changed since the last confirmed transfer; use pull --force to replace it with the remote DAG",
      {
        expected: caught.details?.expected_revision ?? expectedRevision ?? null,
        current: caught.details?.current_revision ?? null,
        force: "pull --force replaces the complete local DAG with the remote snapshot",
      },
      caught,
    );
  }
  if (caught.code === "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE") {
    throw transferError(
      "TRANSFER_BASE_UNKNOWN",
      "transfer: local destination is not pristine and has no transfer baseline; use pull --force only if the remote DAG should replace it",
      { force: "pull --force replaces the complete local DAG with the remote snapshot" },
      caught,
    );
  }
  if (caught.code === "CLIMIER_TRANSFER_INVALID_PAYLOAD") {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote export contained an invalid snapshot", undefined, caught);
  }
  throw error;
}

function ambiguousImportError(error: ReturnType<typeof asCaughtError>): CodedApplicationError {
  return transferError(
    error.code || "REMOTE_REQUEST_FAILED",
    `${error.message}; remote import outcome is ambiguous and the transfer baseline was not advanced; inspect or pull before retrying`,
    { ...(isRecord(error.details) ? error.details : {}), remote_result_ambiguous: true },
    error,
  );
}

async function saveBaseline(store: BaselineStore, record: Baseline, changedSide: string): Promise<void> {
  try {
    await store.set(record);
  } catch (cause: unknown) {
    const caught = asCaughtError(cause);
    throw transferError(
      caught.code || "REMOTE_TRANSFER_BASELINE_ERROR",
      `transfer: ${changedSide}; confirmed remote revision ${record.remote_revision} and local revision ${record.local_revision}, but the transfer baseline could not be persisted: ${caught.message}`,
      {
        direction: changedSide.startsWith("remote") ? "push" : "pull",
        confirmed_remote_revision: record.remote_revision,
        confirmed_local_revision: record.local_revision,
      },
      caught,
    );
  }
}

function result(direction: "push" | "pull", projectId: string, remoteRevision: number, localRevision: number, forced: boolean): {
  transfer: "push" | "pull";
  project_id: string;
  remote_revision: number;
  local_revision: number;
  forced: boolean;
} {
  return {
    transfer: direction,
    project_id: projectId,
    remote_revision: remoteRevision,
    local_revision: localRevision,
    forced,
  };
}

export async function pushManualTransfer(request: unknown): Promise<ReturnType<typeof result>> {
  const input = validateRequest(request);
  const store = createRemoteTransferBaselineStore() as BaselineStore;
  const baseline = await store.get(input.origin, input.projectId);
  const captured = await captureTransferSource({ sourceProjectDir: input.projectDir }) as unknown as CapturedTransfer;
  const importOptions: ImportOptions = { payload: captured.payload, actor: input.actor };
  if (!input.force && baseline) {importOptions.expected_remote_revision = baseline.remote_revision;}
  if (input.force) {importOptions.force = true;}

  let imported: unknown;
  try {
    imported = await input.backendClient.importTransfer(importOptions);
  } catch (error: unknown) {
    const caught = asCaughtError(error);
    if (caught.code === "REMOTE_TIMEOUT" || caught.code === "REMOTE_REQUEST_FAILED") {
      throw ambiguousImportError(caught);
    }
    throw error;
  }
  if (!isRecord(imported)) {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote import response must contain an object with revision", { field: "result" });
  }
  validateRemoteRevision(imported.revision, "import");

  const baselineRecord: Baseline = {
    version: 1,
    origin: input.origin,
    project_id: input.projectId,
    remote_revision: imported.revision,
    local_revision: captured.revision,
  };
  await saveBaseline(store, baselineRecord, "remote DAG changed after confirmed push");
  return result("push", input.projectId, imported.revision, captured.revision, input.force);
}

export async function pullManualTransfer(request: unknown): Promise<ReturnType<typeof result>> {
  const input = validateRequest(request);
  const store = createRemoteTransferBaselineStore() as BaselineStore;
  const baseline = await store.get(input.origin, input.projectId);
  const exported = await input.backendClient.exportTransfer();
  if (!isRecord(exported) || !isRecord(exported.payload)) {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote export response must contain a snapshot payload", { field: "payload" });
  }
  validateRemoteRevision(exported.revision, "export");

  const installOptions: InstallOptions = {
    destinationProjectDir: input.projectDir,
    payload: exported.payload,
    actor: input.actor,
    direction: "pull",
    force: input.force,
  };
  if (!input.force && baseline) {installOptions.expectedRevision = baseline.local_revision;}

  let installed: unknown;
  try {
    installed = await installTransferDestination(installOptions);
  } catch (error: unknown) {
    translateLocalInstallError(error, installOptions.expectedRevision, input.force);
  }
  const localRevision: unknown = isRecord(installed) ? installed.revision : undefined;
  validateRemoteRevision(localRevision, "local install");

  const baselineRecord: Baseline = {
    version: 1,
    origin: input.origin,
    project_id: input.projectId,
    remote_revision: exported.revision,
    local_revision: localRevision,
  };
  await saveBaseline(store, baselineRecord, "local DAG changed after confirmed pull");
  return result("pull", input.projectId, exported.revision, localRevision, input.force);
}
