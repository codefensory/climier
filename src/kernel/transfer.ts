import {
  captureTransferSource as captureTransferSourceFromStorage,
  installTransferDestination as installTransferDestinationInStorage,
  TRANSFER_PAYLOAD_VERSION,
} from "../storage/transfer.ts";

type TransferDirection = "push" | "pull";
type TransferRequest = {
  sourceProjectDir?: unknown;
  destinationProjectDir?: unknown;
  actor?: unknown;
  direction?: unknown;
  expectedRevision?: unknown;
  force?: unknown;
  payload?: unknown;
};

function assertProjectDir(projectDir: unknown, field: string): asserts projectDir is string {
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    throw new Error(`transfer: ${field} is required`);
  }
}

function assertActorAndDirection(actor: unknown, direction: unknown): asserts actor is string {
  if (typeof actor !== "string" || !actor.trim()) {throw new Error("transfer: actor is required");}
  if (!new Set(["push", "pull"]).has(direction as string)) {throw new Error("transfer: direction must be push or pull");}
}

function assertTransferOptions({ expectedRevision, force }: { expectedRevision?: unknown; force?: unknown }) {
  if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error("transfer: expectedRevision must be a non-negative integer");
  }
  if (force !== undefined && typeof force !== "boolean") {throw new Error("transfer: force must be boolean");}
}

function assertTransferRequest(request: TransferRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  assertProjectDir(request.sourceProjectDir, "sourceProjectDir");
  assertProjectDir(request.destinationProjectDir, "destinationProjectDir");
  assertActorAndDirection(request.actor, request.direction);
  assertTransferOptions(request);
}

/** Capture a complete validated DAG snapshot and its consistent source revision. */
export async function captureTransferSource(request: TransferRequest = {}): Promise<Record<string, unknown>> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("transfer: request must be an object");
  }
  const sourceProjectDir = request.sourceProjectDir;
  assertProjectDir(sourceProjectDir, "sourceProjectDir");
  return captureTransferSourceFromStorage(sourceProjectDir);
}

function validateInstallRequest(request: TransferRequest): void {
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
export async function installTransferDestination(request: TransferRequest = {}): Promise<unknown> {
  validateInstallRequest(request);
  validateTransferPayload(request.payload);
  const destinationProjectDir = request.destinationProjectDir;
  assertProjectDir(destinationProjectDir, "destinationProjectDir");
  const actor = request.actor;
  const direction = request.direction;
  assertActorAndDirection(actor, direction);
  return installTransferDestinationInStorage(destinationProjectDir, request.payload, {
    actor,
    direction: direction as TransferDirection,
    expectedRevision: typeof request.expectedRevision === "number" ? request.expectedRevision : undefined,
    force: request.force === true,
  });
}

export async function transferState(request: TransferRequest = {}): Promise<unknown> {
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
