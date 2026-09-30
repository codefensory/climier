import { parseBackendConfig } from "./backend-config.mjs";
import { captureTransferSource, installTransferDestination } from "../kernel/transfer.mjs";
import { createRemoteTransferBaselineStore } from "../storage/remote-transfer-baseline.mjs";

function transferError(code, message, details, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequest(request) {
  if (!isRecord(request)) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: request must be an object");
  }
  if (typeof request.projectDir !== "string" || !request.projectDir.trim()) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: projectDir is required", { field: "projectDir" });
  }
  if (!isRecord(request.projectConfig)) {
    throw transferError("TRANSFER_INVALID_REQUEST", "transfer: projectConfig must be an object", { field: "projectConfig" });
  }
  if (typeof request.projectConfig.project_id !== "string" || !request.projectConfig.project_id.trim()) {
    throw transferError("REMOTE_PROJECT_ID_REQUIRED", "transfer: remote project_id is required", { field: "project_id" });
  }
  if (typeof request.actor !== "string" || !request.actor.trim()) {
    throw transferError("TRANSFER_ACTOR_REQUIRED", "transfer: actor is required", { field: "actor" });
  }
  if (typeof request.force !== "boolean") {
    throw transferError("TRANSFER_FORCE_INVALID", "transfer: force must be boolean", { field: "force" });
  }

  const backend = parseBackendConfig(request.projectConfig);
  if (backend.type !== "remote") {
    throw transferError("REMOTE_BACKEND_REQUIRED", "transfer: manual transfer requires a remote v2 backend");
  }
  if (backend.protocol !== "v2") {
    throw transferError("REMOTE_CONFIG_OUTDATED", "transfer: manual transfer requires remote protocol v2", { expected_protocol: "v2" });
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
    projectConfig: request.projectConfig,
    backendClient: request.backendClient,
    actor: request.actor,
    force: request.force,
    origin: new URL(request.projectConfig.backend.url).origin,
    projectId: request.projectConfig.project_id,
  };
}

function validateRemoteRevision(revision, operation) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw transferError(
      "REMOTE_INVALID_RESPONSE",
      `transfer: remote ${operation} response must contain a non-negative integer revision`,
      { field: "revision" },
    );
  }
}

function translateLocalInstallError(error, expectedRevision, force) {
  if (error?.code === "CLIMIER_TRANSFER_REVISION_MISMATCH") {
    throw transferError(
      "TRANSFER_LOCAL_CHANGED",
      "transfer: local state changed since the last confirmed transfer; use pull --force to replace it with the remote DAG",
      {
        expected: error.details?.expected_revision ?? expectedRevision ?? null,
        current: error.details?.current_revision ?? null,
        force: "pull --force replaces the complete local DAG with the remote snapshot",
      },
      error,
    );
  }
  if (error?.code === "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE") {
    throw transferError(
      "TRANSFER_BASE_UNKNOWN",
      "transfer: local destination is not pristine and has no transfer baseline; use pull --force only if the remote DAG should replace it",
      { force: "pull --force replaces the complete local DAG with the remote snapshot" },
      error,
    );
  }
  if (error?.code === "CLIMIER_TRANSFER_INVALID_PAYLOAD") {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote export contained an invalid snapshot", undefined, error);
  }
  throw error;
}

function ambiguousImportError(error) {
  return transferError(
    error.code,
    `${error.message}; remote import outcome is ambiguous and the transfer baseline was not advanced; inspect or pull before retrying`,
    { ...(isRecord(error.details) ? error.details : {}), remote_result_ambiguous: true },
    error,
  );
}

async function saveBaseline(store, record, changedSide) {
  try {
    await store.set(record);
  } catch (cause) {
    throw transferError(
      cause?.code || "REMOTE_TRANSFER_BASELINE_ERROR",
      `transfer: ${changedSide}; confirmed remote revision ${record.remote_revision} and local revision ${record.local_revision}, but the transfer baseline could not be persisted: ${cause.message}`,
      {
        direction: changedSide.startsWith("remote") ? "push" : "pull",
        confirmed_remote_revision: record.remote_revision,
        confirmed_local_revision: record.local_revision,
      },
      cause,
    );
  }
}

function result(direction, projectId, remoteRevision, localRevision, forced) {
  return {
    transfer: direction,
    project_id: projectId,
    remote_revision: remoteRevision,
    local_revision: localRevision,
    forced,
  };
}

export async function pushManualTransfer(request) {
  const input = validateRequest(request);
  const store = createRemoteTransferBaselineStore();
  const baseline = await store.get(input.origin, input.projectId);
  const captured = await captureTransferSource({ sourceProjectDir: input.projectDir });
  const importOptions = { payload: captured.payload, actor: input.actor };
  if (!input.force && baseline) {importOptions.expected_remote_revision = baseline.remote_revision;}
  if (input.force) {importOptions.force = true;}

  let imported;
  try {
    imported = await input.backendClient.importTransfer(importOptions);
  } catch (error) {
    if (error?.code === "REMOTE_TIMEOUT" || error?.code === "REMOTE_REQUEST_FAILED") {
      throw ambiguousImportError(error);
    }
    throw error;
  }
  if (!isRecord(imported)) {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote import response must contain an object with revision", { field: "result" });
  }
  validateRemoteRevision(imported.revision, "import");

  const baselineRecord = {
    version: 1,
    origin: input.origin,
    project_id: input.projectId,
    remote_revision: imported.revision,
    local_revision: captured.revision,
  };
  await saveBaseline(store, baselineRecord, `remote DAG changed after confirmed push`);
  return result("push", input.projectId, imported.revision, captured.revision, input.force);
}

export async function pullManualTransfer(request) {
  const input = validateRequest(request);
  const store = createRemoteTransferBaselineStore();
  const baseline = await store.get(input.origin, input.projectId);
  const exported = await input.backendClient.exportTransfer();
  if (!isRecord(exported) || !isRecord(exported.payload)) {
    throw transferError("REMOTE_INVALID_RESPONSE", "transfer: remote export response must contain a snapshot payload", { field: "payload" });
  }
  validateRemoteRevision(exported.revision, "export");

  const installOptions = {
    destinationProjectDir: input.projectDir,
    payload: exported.payload,
    actor: input.actor,
    direction: "pull",
    force: input.force,
  };
  if (!input.force && baseline) {installOptions.expectedRevision = baseline.local_revision;}

  let installed;
  try {
    installed = await installTransferDestination(installOptions);
  } catch (error) {
    translateLocalInstallError(error, installOptions.expectedRevision, input.force);
  }
  validateRemoteRevision(installed?.revision, "local install");

  const baselineRecord = {
    version: 1,
    origin: input.origin,
    project_id: input.projectId,
    remote_revision: exported.revision,
    local_revision: installed.revision,
  };
  await saveBaseline(store, baselineRecord, `local DAG changed after confirmed pull`);
  return result("pull", input.projectId, exported.revision, installed.revision, input.force);
}
