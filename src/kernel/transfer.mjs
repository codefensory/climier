import { prepareLogEntry } from "../storage/log.mjs";
import {
  captureTransferSource as captureTransferSourceFromStorage,
  installTransferDestination as installTransferDestinationInStorage,
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

function assertOverwrite(overwrite) {
  if (overwrite !== undefined && typeof overwrite !== "boolean") {throw new Error("transfer: overwrite must be boolean");}
}

function assertTransferRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.sourceProjectDir, "sourceProjectDir");
  assertProjectDir(request.destinationProjectDir, "destinationProjectDir");
  assertActorAndDirection(request.actor, request.direction);
  assertOverwrite(request.overwrite);
}

/** Capture a complete validated DAG snapshot without adding an audit event. */
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
  assertOverwrite(request.overwrite);
}

function validateTransferPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.log)) {
    throw new Error("transfer: payload must be a transfer snapshot with a log array");
  }
}

function transferPayloadWithAudit(payload, actor, direction) {
  return {
    ...payload,
    log: [...payload.log, prepareLogEntry({ action: `transfer.${direction}`, agent: actor })],
  };
}

/** Install a captured snapshot and append exactly one kernel-owned audit event. */
export async function installTransferDestination(request = {}) {
  validateInstallRequest(request);
  validateTransferPayload(request.payload);
  const payload = transferPayloadWithAudit(request.payload, request.actor, request.direction);
  return installTransferDestinationInStorage(request.destinationProjectDir, payload, {
    overwrite: request.overwrite === true,
  });
}


export async function transferState(request = {}) {
  assertTransferRequest(request);
  const payload = await captureTransferSource({ sourceProjectDir: request.sourceProjectDir });
  return installTransferDestination({
    destinationProjectDir: request.destinationProjectDir,
    payload,
    actor: request.actor,
    direction: request.direction,
    overwrite: request.overwrite,
  });
}
