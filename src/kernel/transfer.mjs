import {
  captureTransferSource as captureTransferSourceFromStorage,
  installTransferDestination as installTransferDestinationInStorage,
  TRANSFER_PAYLOAD_VERSION,
} from "../storage/transfer.mjs";

function assertProjectDir(projectDir, field) {
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    throw new Error(`transfer: ${field} is required`);
  }
}

function assertActorAndDirection(actor, direction) {
  if (typeof actor !== "string" || !actor.trim()) {throw new Error("transfer: actor is required");}
  if (!new Set(["push", "pull"]).has(direction)) {throw new Error("transfer: direction must be push or pull");}
}

function assertTransferOptions({ expectedRevision, force }) {
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error("transfer: expectedRevision must be a non-negative integer");
  }
  if (force !== undefined && typeof force !== "boolean") {throw new Error("transfer: force must be boolean");}
}

function assertTransferRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.sourceProjectDir, "sourceProjectDir");
  assertProjectDir(request.destinationProjectDir, "destinationProjectDir");
  assertActorAndDirection(request.actor, request.direction);
  assertTransferOptions(request);
}

/** Capture a complete validated DAG snapshot and its consistent source revision. */
export async function captureTransferSource(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.sourceProjectDir, "sourceProjectDir");
  return captureTransferSourceFromStorage(request.sourceProjectDir);
}

function validateInstallRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.destinationProjectDir, "destinationProjectDir");
  assertActorAndDirection(request.actor, request.direction);
  assertTransferOptions(request);
}

function validateTransferPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.version !== TRANSFER_PAYLOAD_VERSION || !payload.nodes || typeof payload.nodes !== "object" || Array.isArray(payload.nodes)
      || !Array.isArray(payload.edges) || !payload.initiatives || typeof payload.initiatives !== "object"
      || Array.isArray(payload.initiatives) || !Array.isArray(payload.log)) {
    throw new Error("transfer: payload must be a complete transfer snapshot");
  }
}

/** Install a captured snapshot; storage appends its audit event under the destination lock. */
export async function installTransferDestination(request = {}) {
  validateInstallRequest(request);
  validateTransferPayload(request.payload);
  return installTransferDestinationInStorage(request.destinationProjectDir, request.payload, {
    actor: request.actor,
    direction: request.direction,
    expectedRevision: request.expectedRevision,
    force: request.force === true,
  });
}

export async function transferState(request = {}) {
  assertTransferRequest(request);
  const captured = await captureTransferSource({ sourceProjectDir: request.sourceProjectDir });
  return installTransferDestination({
    destinationProjectDir: request.destinationProjectDir,
    payload: captured.payload,
    actor: request.actor,
    direction: request.direction,
    expectedRevision: request.expectedRevision,
    force: request.force,
  });
}
