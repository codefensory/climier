import { captureTransferSource, installTransferDestination } from "../../kernel/transfer.mjs";

const TRANSFER_PAYLOAD_FIELDS = new Set(["version", "revision", "nodes", "edges", "initiatives", "log"]);

export function validateTransferRequest(body, route, httpError) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("INVALID_REQUEST", "server http: transfer request must be a JSON object", { field: "body" }, 400);
  }
  const allowed = route === "transfer/export" ? new Set() : new Set(["payload", "actor", "overwrite"]);
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer field '${field}' is not allowed`, { field }, 400);
    }
  }
  if (route === "transfer/export") return body;
  if (typeof body.actor !== "string" || !body.actor.trim()) {
    throw httpError("INVALID_REQUEST", "server http: transfer actor is required", { field: "actor" }, 400);
  }
  if (!Object.hasOwn(body, "payload")) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload is required", { field: "payload" }, 400);
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    throw httpError("INVALID_REQUEST", "server http: transfer overwrite must be boolean", { field: "overwrite" }, 400);
  }
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload must be an object", { field: "payload" }, 400);
  }
  for (const field of Object.keys(payload)) {
    if (!TRANSFER_PAYLOAD_FIELDS.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer payload field '${field}' is not allowed`, { field: `payload.${field}` }, 400);
    }
  }
  for (const field of TRANSFER_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      throw httpError("INVALID_REQUEST", `server http: transfer payload field '${field}' is required`, { field: `payload.${field}` }, 400);
    }
  }
  if (payload.version !== 4 || !payload.nodes || typeof payload.nodes !== "object" || Array.isArray(payload.nodes)
      || !Array.isArray(payload.edges) || !payload.initiatives || typeof payload.initiatives !== "object"
      || Array.isArray(payload.initiatives) || !Array.isArray(payload.log)) {
    throw httpError("INVALID_REQUEST", "server http: transfer payload has an invalid snapshot shape", { field: "payload" }, 400);
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
