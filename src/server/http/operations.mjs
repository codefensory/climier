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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
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

function invalidRequest(httpError, message, field, details = { field }) {
  throw httpError("INVALID_REQUEST", `server http: ${message}`, details, 400);
}

function validateTopLevelFields(body, httpError) {
  for (const field of Object.keys(body)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.has(field) || !ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      invalidRequest(httpError, `request field '${field}' is not allowed`, field);
    }
  }
}

function validateBatchOperationFields(operation, field, batch, httpError) {
  for (const key of Object.keys(operation)) {
    if (!batch.operationFields.includes(key)) {
      invalidRequest(httpError, `${field}.${key} is not allowed`, `${field}.${key}`);
    }
  }
}

function validateBatchOperationInput(operation, field, operationsById, httpError) {
  if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
    invalidRequest(httpError, `${field}.input must be an object`, `${field}.input`);
  }
  const allowedFields = operationsById.get(operation.op)?.httpFields;
  for (const key of Object.keys(operation.input)) {
    if (!allowedFields?.includes(key)) {
      invalidRequest(httpError, `${field}.input field '${key}' is not allowed for ${operation.op}`, `${field}.input.${key}`, {
        field: `${field}.input.${key}`,
        operation: operation.op,
      });
    }
  }
  validateInputFields(operation.input, `${field}.input`, httpError);
}

function validateBatchOperation(operation, index, { batch, operationsById, httpError }) {
  const field = `input.operations[${index}]`;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    invalidRequest(httpError, `${field} must be an object`, field);
  }
  validateBatchOperationFields(operation, field, batch, httpError);
  const validId = typeof operation.op === "string" && operation.op.length > 0
    && batch.eligibleOperationIds.includes(operation.op) && operation.op !== batch.id;
  if (!validId) {
    invalidRequest(httpError, `${field}.op must name an allowed built-in operation`, `${field}.op`);
  }
  validateBatchOperationInput(operation, field, operationsById, httpError);
}

function validateBatchInput(input, { batch, operationsById, httpError }) {
  for (const field of Object.keys(input)) {
    if (!batch.inputFields.includes(field)) {
      invalidRequest(httpError, `input field '${field}' is not allowed for ${batch.id}`, `input.${field}`, {
        field: `input.${field}`,
        operation: batch.id,
      });
    }
  }
  const { operations } = input;
  if (!Array.isArray(operations) || operations.length === 0) {
    invalidRequest(httpError, "input.operations must be a non-empty array", "input.operations");
  }
  operations.forEach((operation, index) => validateBatchOperation(operation, index, {
    batch,
    operationsById,
    httpError,
  }));
  if (Object.hasOwn(input, "if_state_revision")
      && (!Number.isSafeInteger(input.if_state_revision) || input.if_state_revision < 0)) {
    invalidRequest(httpError, "input.if_state_revision must be a non-negative safe integer", "input.if_state_revision");
  }
}

function validateOperationIdentity(body, { batch, operationIds, httpError }) {
  if (typeof body.operation !== "string" || body.operation.length === 0) {
    invalidRequest(httpError, "operation is required", "operation");
  }
  if (operationIds.has(body.operation) || body.operation === batch.id) {
    return;
  }
  const error = new Error(`application.executeOperation: operation '${body.operation}' is not registered`);
  error.code = "OPERATION_NOT_FOUND";
  error.details = { operation: body.operation };
  error.status = 404;
  throw error;
}

function validateRequestActorAndInput(body, httpError) {
  if (typeof body.actor !== "string" || body.actor.length === 0) {
    invalidRequest(httpError, "actor is required", "actor");
  }
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    invalidRequest(httpError, "input must be a JSON object", "input");
  }
}

function validateSingleOperationInput(body, { operationsById, httpError }) {
  const allowedFields = operationsById.get(body.operation)?.httpFields;
  if (!allowedFields) {
    throw httpError("OPERATION_NOT_FOUND", `application.executeOperation: operation '${body.operation}' is not available in protocol v1`, {
      operation: body.operation,
    }, 404);
  }
  for (const field of Object.keys(body.input)) {
    if (!allowedFields.includes(field)) {
      invalidRequest(httpError, `input field '${field}' is not allowed for ${body.operation}`, `input.${field}`, {
        field: `input.${field}`,
        operation: body.operation,
      });
    }
  }
  validateInputFields(body.input, "input", httpError);
}

export function validateOperationRequest(body, { manifest, httpError }) {
  const capabilities = operationCapabilities(manifest);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalidRequest(httpError, "operation request must be a JSON object", "body");
  }
  validateTopLevelFields(body, httpError);
  validateOperationIdentity(body, { ...capabilities, httpError });
  validateRequestActorAndInput(body, httpError);
  if (body.operation === capabilities.batch.id) {
    validateBatchInput(body.input, { ...capabilities, httpError });
  } else {
    validateSingleOperationInput(body, { operationsById: capabilities.operationsById, httpError });
  }
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
