import {
  executeBatch as executeBatchDefault,
  executeOperation as executeOperationDefault,
} from "../../application/operations/index.mjs";

const FORBIDDEN_INPUT_FIELDS = new Set([
  "actor",
  "as",
  "_as",
  "pluginId",
  "plugin_id",
  "handler",
  "argv",
  "allow_unregistered_initiative",
  "if_state_revision",
]);
const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  "pluginId",
  "plugin_id",
  "handler",
  "argv",
  "source",
  "registry",
  "provider",
  "projectDir",
  "project_dir",
]);
const ALLOWED_TOP_LEVEL_FIELDS = new Set(["operation", "input", "actor"]);

function validateInputFields(value, field, httpError) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_FIELDS.has(key)) {
      throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
    }
    validateInputFields(child, `${field}.${key}`, httpError);
  }
}

function operationCapabilities(manifest) {
  const operationsById = new Map(manifest.operations.map((operation) => [operation.id, operation]));
  return { operationsById, operationIds: new Set(operationsById.keys()), batch: manifest.batch };
}

export function validateOperationRequest(body, { manifest, httpError }) {
  const { operationsById, operationIds, batch } = operationCapabilities(manifest);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("INVALID_REQUEST", "server http: operation request must be a JSON object", { field: "body" }, 400);
  }
  for (const field of Object.keys(body)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.has(field) || !ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      throw httpError("INVALID_REQUEST", `server http: request field '${field}' is not allowed`, { field }, 400);
    }
  }
  if (typeof body.operation !== "string" || body.operation.length === 0) {
    throw httpError("INVALID_REQUEST", "server http: operation is required", { field: "operation" }, 400);
  }
  if (!operationIds.has(body.operation) && body.operation !== batch.id) {
    const error = new Error(`application.executeOperation: operation '${body.operation}' is not registered`);
    error.code = "OPERATION_NOT_FOUND";
    error.details = { operation: body.operation };
    error.status = 404;
    throw error;
  }
  if (typeof body.actor !== "string" || body.actor.length === 0) {
    throw httpError("INVALID_REQUEST", "server http: actor is required", { field: "actor" }, 400);
  }
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    throw httpError("INVALID_REQUEST", "server http: input must be a JSON object", { field: "input" }, 400);
  }
  if (body.operation === batch.id) {
    for (const field of Object.keys(body.input)) {
      if (!batch.inputFields.includes(field)) {
        throw httpError("INVALID_REQUEST", `server http: input field '${field}' is not allowed for ${batch.id}`, { field: `input.${field}`, operation: batch.id }, 400);
      }
    }
    const operations = body.input.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw httpError("INVALID_REQUEST", "server http: input.operations must be a non-empty array", { field: "input.operations" }, 400);
    }
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const field = `input.operations[${index}]`;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw httpError("INVALID_REQUEST", `server http: ${field} must be an object`, { field }, 400);
      }
      for (const key of Object.keys(operation)) {
        if (!batch.operationFields.includes(key)) {
          throw httpError("INVALID_REQUEST", `server http: ${field}.${key} is not allowed`, { field: `${field}.${key}` }, 400);
        }
      }
      if (typeof operation.op !== "string" || operation.op.length === 0 || !batch.eligibleOperationIds.includes(operation.op) || operation.op === batch.id) {
        throw httpError("INVALID_REQUEST", `server http: ${field}.op must name an allowed built-in operation`, { field: `${field}.op` }, 400);
      }
      if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
        throw httpError("INVALID_REQUEST", `server http: ${field}.input must be an object`, { field: `${field}.input` }, 400);
      }
      const allowedOperationFields = operationsById.get(operation.op)?.httpFields;
      for (const key of Object.keys(operation.input)) {
        if (!allowedOperationFields?.includes(key)) {
          throw httpError("INVALID_REQUEST", `server http: ${field}.input field '${key}' is not allowed for ${operation.op}`, { field: `${field}.input.${key}`, operation: operation.op }, 400);
        }
      }
      validateInputFields(operation.input, field + ".input", httpError);
    }
    if (Object.hasOwn(body.input, "if_state_revision") && (!Number.isSafeInteger(body.input.if_state_revision) || body.input.if_state_revision < 0)) {
      throw httpError("INVALID_REQUEST", "server http: input.if_state_revision must be a non-negative safe integer", { field: "input.if_state_revision" }, 400);
    }
    return body;
  }
  const allowedFields = operationsById.get(body.operation)?.httpFields;
  if (!allowedFields) {
    throw httpError("OPERATION_NOT_FOUND", `application.executeOperation: operation '${body.operation}' is not available in protocol v1`, { operation: body.operation }, 404);
  }
  for (const field of Object.keys(body.input)) {
    if (!allowedFields.includes(field)) {
      throw httpError("INVALID_REQUEST", `server http: input field '${field}' is not allowed for ${body.operation}`, { field: `input.${field}`, operation: body.operation }, 400);
    }
  }
  validateInputFields(body.input, "input", httpError);
  return body;
}

export async function dispatchOperationRequest({
  projectDir,
  body,
  source,
  manifest,
  executeOperation = executeOperationDefault,
  executeBatch = executeBatchDefault,
}) {
  const batchId = manifest.batch.id;
  if (body.operation === batchId) {
    return await executeBatch({ projectDir, actor: body.actor, input: body.input, source });
  }
  return await executeOperation({
    projectDir,
    actor: body.actor,
    operation: body.operation,
    input: body.input,
    source,
  });
}
