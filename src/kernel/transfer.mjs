import { prepareLogEntry } from "../storage/log.mjs";
import { captureTransferSource, installTransferDestination } from "../storage/transfer.mjs";

function assertTransferRequest({ sourceProjectDir, destinationProjectDir, actor, direction, overwrite }) {
  if (typeof sourceProjectDir !== "string" || !sourceProjectDir.trim()
      || typeof destinationProjectDir !== "string" || !destinationProjectDir.trim()) {
    throw new Error("transfer: sourceProjectDir and destinationProjectDir are required");
  }
  if (typeof actor !== "string" || !actor.trim()) throw new Error("transfer: actor is required");
  if (!new Set(["push", "pull"]).has(direction)) throw new Error("transfer: direction must be push or pull");
  if (overwrite !== undefined && typeof overwrite !== "boolean") throw new Error("transfer: overwrite must be boolean");
}

/** Copy a complete validated DAG snapshot between project stores. */
export async function transferState(request = {}) {
  assertTransferRequest(request);
  const payload = await captureTransferSource(request.sourceProjectDir);
  payload.log.push(prepareLogEntry({
    action: `transfer.${request.direction}`,
    agent: request.actor,
  }));
  return installTransferDestination(request.destinationProjectDir, payload, { overwrite: request.overwrite === true });
}
