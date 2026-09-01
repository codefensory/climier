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

function invalidJsonValue(operation, field, reason) {
  throwV2("PLUGIN_DATA_INVALID", `${operation}: ${field} must be a JSON-safe value`, {
    field,
    reason,
  });
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key) {
  if (key === "") return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}

// Validate the plugin data contract without invoking getters or relying on
// JSON.stringify (which silently drops undefined, symbols and non-enumerable
// fields). WeakSet tracks the current path, so shared acyclic references are
// allowed while cycles are rejected.
export function validateJsonValue(value, operation, field = "value", ancestors = new WeakSet()) {
  if (value === null) return value;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (Number.isFinite(value)) return value;
    invalidJsonValue(operation, field, "number must be finite");
  }
  if (type !== "object") invalidJsonValue(operation, field, `unsupported type ${type}`);
  if (ancestors.has(value)) invalidJsonValue(operation, field, "cyclic reference");
  ancestors.add(value);

  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidJsonValue(operation, `${field}.${String(key)}`, "symbol property");
      if (key !== "length" && !isArrayIndex(key)) {
        invalidJsonValue(operation, `${field}.${key}`, "array has a non-index property");
      }
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        invalidJsonValue(operation, `${field}[${key}]`, "array property must be an enumerable data property");
      }
      validateJsonValue(descriptor.value, operation, `${field}[${key}]`, ancestors);
    }
  } else {
    if (!isPlainObject(value)) invalidJsonValue(operation, field, "value must be a plain object");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidJsonValue(operation, `${field}.${String(key)}`, "symbol property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        invalidJsonValue(operation, `${field}.${key}`, "object property must be an enumerable data property");
      }
      validateJsonValue(descriptor.value, operation, `${field}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return value;
}

export function cloneValue(value, operation, field = "value") {
  validateJsonValue(value, operation, field);
  try {
    return structuredClone(value);
  } catch (err) {
    throwV2("PLUGIN_DATA_INVALID", `${operation}: ${field} must be cloneable JSON data`, {
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
