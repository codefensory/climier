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
  if (typeof actor !== "string" || !actor.trim()) throw new Error("transfer: actor is required");
  if (!new Set(["push", "pull"]).has(direction)) throw new Error("transfer: direction must be push or pull");
}

function assertOverwrite(overwrite) {
  if (overwrite !== undefined && typeof overwrite !== "boolean") throw new Error("transfer: overwrite must be boolean");
}

function assertTransferRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  if (typeof request.sourceProjectDir !== "string" || !request.sourceProjectDir.trim()
      || typeof request.destinationProjectDir !== "string" || !request.destinationProjectDir.trim()) {
    throw new Error("transfer: sourceProjectDir and destinationProjectDir are required");
  }
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

/** Install a captured snapshot and append exactly one kernel-owned audit event. */
export async function installTransferDestination(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.destinationProjectDir, "destinationProjectDir");
  assertActorAndDirection(request.actor, request.direction);
  assertOverwrite(request.overwrite);
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)
      || !Array.isArray(request.payload.log)) {
    throw new Error("transfer: payload must be a transfer snapshot with a log array");
  }

  const payload = {
    ...request.payload,
    log: [...request.payload.log, prepareLogEntry({
      action: `transfer.${request.direction}`,
      agent: request.actor,
    })],
  };
  return installTransferDestinationInStorage(request.destinationProjectDir, payload, {
    overwrite: request.overwrite === true,
  });
}

/** Copy a complete validated DAG snapshot between project stores. */
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
