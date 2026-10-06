import { captureTransferSource, installTransferDestination } from "../../kernel/transfer.ts";

const TRANSFER_PAYLOAD_VERSION = 1;
const TRANSFER_PAYLOAD_FIELDS = new Set(["version", "nodes", "edges", "initiatives", "log", "plugins"]);
const TRANSFER_REQUEST_FIELDS = new Set(["payload", "actor", "expected_remote_revision", "force"]);

function invalidTransferRequest(httpError, message, field) {
  throw httpError("INVALID_REQUEST", `server http: ${message}`, { field }, 400);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  for (const field of ["version", "nodes", "edges", "initiatives", "log"]) {
    if (!Object.hasOwn(payload, field)) {
      invalidTransferRequest(httpError, `transfer payload field '${field}' is required`, `payload.${field}`);
    }
  }
  if (payload.version !== TRANSFER_PAYLOAD_VERSION || !isRecord(payload.nodes) || !Array.isArray(payload.edges)
      || !isRecord(payload.initiatives) || !Array.isArray(payload.log)) {
    invalidTransferRequest(httpError, "transfer payload has an invalid snapshot shape", "payload");
  }
}

export function validateTransferRequest(body, httpError) {
  if (!isRecord(body)) {
    invalidTransferRequest(httpError, "transfer request must be a JSON object", "body");
  }
  for (const field of Object.keys(body)) {
    if (!TRANSFER_REQUEST_FIELDS.has(field)) {
      invalidTransferRequest(httpError, `transfer field '${field}' is not allowed`, field);
    }
  }
  if (typeof body.actor !== "string" || !body.actor.trim()) {
    invalidTransferRequest(httpError, "transfer actor is required", "actor");
  }
  if (!Object.hasOwn(body, "payload")) {
    invalidTransferRequest(httpError, "transfer payload is required", "payload");
  }
  if (body.expected_remote_revision !== undefined
      && (!Number.isInteger(body.expected_remote_revision) || body.expected_remote_revision < 0)) {
    invalidTransferRequest(httpError, "expected_remote_revision must be a non-negative integer", "expected_remote_revision");
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    invalidTransferRequest(httpError, "transfer force must be boolean", "force");
  }
  if (body.force === true && body.expected_remote_revision !== undefined) {
    invalidTransferRequest(httpError, "force cannot be combined with expected_remote_revision", "expected_remote_revision");
  }
  validateTransferPayload(body.payload, httpError);
  return body;
}

function translateTransferError(error, httpError) {
  if (error?.code === "CLIMIER_TRANSFER_REVISION_MISMATCH") {
    throw httpError("TRANSFER_REMOTE_CHANGED", "server http: remote project revision changed", {
      expected: error.details?.expected_revision ?? null,
      current: error.details?.current_revision ?? null,
    }, 409);
  }
  if (error?.code === "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE") {
    throw httpError("TRANSFER_BASE_UNKNOWN", "server http: remote project is not pristine and no expected revision was supplied", undefined, 409);
  }
  if (error?.code === "CLIMIER_TRANSFER_INVALID_PAYLOAD") {
    throw httpError("INVALID_REQUEST", "server http: transfer payload is invalid", undefined, 400);
  }
  if (error?.code === "CLIMIER_TRANSFER_INVALID_SOURCE") {
    throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
  }
  throw error;
}

export async function executeTransferRequest({ projectDir, route, body, httpError }) {
  if (route === "transfer/export") {
    try {
      return await captureTransferSource({ sourceProjectDir: projectDir });
    } catch (error) {
      translateTransferError(error, httpError);
    }
  }
  try {
    return await installTransferDestination({
      destinationProjectDir: projectDir,
      payload: body.payload,
      actor: body.actor,
      direction: "push",
      expectedRevision: body.expected_remote_revision,
      force: body.force === true,
    });
  } catch (error) {
    translateTransferError(error, httpError);
  }
}
