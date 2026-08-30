import { throwV2 } from "../../contracts/errors.mjs";

export function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function pluginIdFrom(request, explicitPluginId, operation) {
  const value = explicitPluginId || (request && (request.plugin_id || request.pluginId));
  const pluginId = nonEmpty(value);
  if (!pluginId) {
    throwV2("MISSING_FIELD", `${operation}: plugin identity is required`, { field: "pluginId" });
  }
  return pluginId;
}

export function cloneValue(value, operation, field = "value") {
  try {
    return structuredClone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${operation}: ${field} must be cloneable data`, {
      field,
      cause: err && err.name ? err.name : "DataCloneError",
    });
  }
}

export function validateValue(input, operation) {
  if (!Object.prototype.hasOwnProperty.call(input, "value")) {
    throwV2("MISSING_FIELD", `${operation}: value is required`, { field: "value" });
  }
  return cloneValue(input.value, operation);
}

export function planPolicyAction(operation, pluginId) {
  return Object.freeze({ action: operation, pluginId });
}
