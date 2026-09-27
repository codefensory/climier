import { captureTransferSource, installTransferDestination } from "../../kernel/transfer.mjs";

const TRANSFER_PAYLOAD_VERSION = 1;
const TRANSFER_PAYLOAD_FIELDS = new Set(["version", "fence_generation", "revision", "nodes", "edges", "initiatives", "log"]);

function invalidTransferRequest(httpError, message, field) {
  throw httpError("INVALID_REQUEST", `server http: ${message}`, { field }, 400);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasValidTransferSnapshotShape(payload) {
  return payload.version === TRANSFER_PAYLOAD_VERSION && Number.isInteger(payload.fence_generation)
    && isRecord(payload.nodes) && Array.isArray(payload.edges)
    && isRecord(payload.initiatives) && Array.isArray(payload.log);
}

function validateTransferPayload(payload, httpError) {
  if (!isRecord(payload)) {
    invalidTransferRequest(httpError, "transfer payload must be an object", "payload");
  }
  for (const field of Object.keys(payload)) {
    if (!TRANSFER_PAYLOAD_FIELDS.has(field)) {
      invalidTransferRequest(httpError, `transfer payload field '${field}' is not allowed`, `payload.${field}`);
    }
  }
  for (const field of TRANSFER_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      invalidTransferRequest(httpError, `transfer payload field '${field}' is required`, `payload.${field}`);
    }
  }
  if (!hasValidTransferSnapshotShape(payload)) {
    invalidTransferRequest(httpError, "transfer payload has an invalid snapshot shape", "payload");
  }
}

function validateTransferBody(body, route, httpError) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalidTransferRequest(httpError, "transfer request must be a JSON object", "body");
  }
  const allowed = route === "transfer/export" ? new Set() : new Set(["payload", "actor", "overwrite"]);
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) {
      invalidTransferRequest(httpError, `transfer field '${field}' is not allowed`, field);
    }
  }
}

function validateTransferImport(body, httpError) {
  if (typeof body.actor !== "string" || !body.actor.trim()) {
    invalidTransferRequest(httpError, "transfer actor is required", "actor");
  }
  if (!Object.hasOwn(body, "payload")) {
    invalidTransferRequest(httpError, "transfer payload is required", "payload");
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    invalidTransferRequest(httpError, "transfer overwrite must be boolean", "overwrite");
  }
  validateTransferPayload(body.payload, httpError);
}

export function validateTransferRequest(body, route, httpError) {
  validateTransferBody(body, route, httpError);
  if (route !== "transfer/export") {
    validateTransferImport(body, httpError);
  }
  return body;
}

export async function executeTransferRequest({ projectDir, route, body }) {
  if (route === "transfer/export") {
    return captureTransferSource({ sourceProjectDir: projectDir });
  }
  return installTransferDestination({
    destinationProjectDir: projectDir,
    payload: body.payload,
    actor: body.actor,
    direction: "push",
    overwrite: body.overwrite === true,
  });
}
