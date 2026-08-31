// execution-contract.mjs — validation + normalization for meta.execution.
//
// `meta.execution` is the optional, structured contract that workers publish
// about a task. It is shaped as:
//
//   {
//     effort:  "S" | "M" | "L",
//     risk:    "isolated" | "integration" | "public-surface",
//     owns:    string[],  // non-empty array of repo-relative paths
//     reads:   string[],  // array of repo-relative paths
//     seam:    string,    // short description of the seam / contract surface
//     checks:  string[],  // shell commands the agent intends to run
//   }
//
// Each property is OPTIONAL inside meta.execution: a partial contract is
// allowed. But when a property is present, its type / contents MUST validate.
// Other top-level keys on `meta` (not in this schema) are passed through
// unchanged so unrelated metadata remains intact.
//
// Public surface:
//   - validateExecution(meta) -> { ok: true, contract } | { ok: false, error }
//     Validates the meta block. `contract` is the normalized version (paths
//     trimmed, arrays deduplicated, defaults preserved) suitable for
//     persisting back to meta.execution.
//   - normalizeExecution(contract) -> contract
//     Pure: trims string entries, dedupes arrays, drops empty strings.
//   - executionContractFor(state, id) -> contract | null
//     Helper that pulls and normalizes the contract from a node's meta.

import { throwV2 } from "../contracts/errors.mjs";

export const EFFORT_VALUES = Object.freeze(["S", "M", "L"]);
export const RISK_VALUES = Object.freeze(["isolated", "integration", "public-surface"]);

// Schema descriptor. Each entry: kind, optional, validator, normalizer.
// Used by validateExecution to drive the per-field checks. Keep declarative
// so adding a new contract field is a one-liner plus a normalizer.
const SCHEMA = {
  effort: {
    kind: "enum",
    values: EFFORT_VALUES,
  },
  risk: {
    kind: "enum",
    values: RISK_VALUES,
  },
  owns: {
    kind: "path-array",
    nonEmpty: true,
  },
  reads: {
    kind: "path-array",
    nonEmpty: false,
  },
  checks: {
    kind: "string-array",
    nonEmpty: false,
  },
  seam: {
    kind: "string",
    nonEmpty: true,
  },
};

const SCHEMA_KEYS = Object.freeze(Object.keys(SCHEMA));

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimAndFilter(value) {
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePathArray(value) {
  const seen = new Set();
  const out = [];
  for (const entry of asArray(value)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeStringArray(value) {
  const seen = new Set();
  const out = [];
  for (const entry of asArray(value)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeString(value) {
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Pure: take a raw meta.execution and produce a normalized contract.
// Returns null for null/undefined input. Throws via throwV2 when the
// shape itself is broken (so callers can wrap it in a friendlier code).
export function normalizeExecution(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throwV2("INVALID_EXECUTION_CONTRACT", "meta.execution must be a JSON object", { value: raw });
  }
  const out = {};
  for (const key of SCHEMA_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    switch (key) {
      case "effort":
      case "risk":
        if (typeof value !== "string" || !SCHEMA[key].values.includes(value)) {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must be one of ${SCHEMA[key].values.join(", ")} (got '${value}')`,
            { field: key, value, allowed: SCHEMA[key].values },
          );
        }
        out[key] = value;
        break;
      case "owns":
      case "reads": {
        if (!isStringArray(value)) {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must be an array of strings`,
            { field: key, value },
          );
        }
        const normalized = normalizePathArray(value);
        if (SCHEMA[key].nonEmpty && normalized.length === 0) {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must contain at least one non-empty path`,
            { field: key, value },
          );
        }
        if (normalized.length > 0) out[key] = normalized;
        break;
      }
      case "checks": {
        if (!isStringArray(value)) {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must be an array of strings`,
            { field: key, value },
          );
        }
        const normalized = normalizeStringArray(value);
        if (normalized.length > 0) out[key] = normalized;
        break;
      }
      case "seam": {
        if (typeof value !== "string") {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must be a string`,
            { field: key, value },
          );
        }
        const normalized = normalizeString(value);
        if (!normalized) {
          throwV2(
            "INVALID_EXECUTION_CONTRACT",
            `meta.execution.${key} must be a non-empty string`,
            { field: key, value },
          );
        }
        out[key] = normalized;
        break;
      }
      default:
        break;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Validate a meta block. Returns the meta object unchanged if no execution
// sub-block is present. Otherwise returns the meta with execution replaced
// by the normalized contract. Throws via throwV2 on invalid shape.
export function validateExecution(rawMeta) {
  if (rawMeta === undefined || rawMeta === null) return rawMeta;
  if (typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    // Already rejected upstream by parseMeta; defensive re-check.
    throwV2("INVALID_EXECUTION_CONTRACT", "meta must be a JSON object", { value: rawMeta });
  }
  if (!("execution" in rawMeta)) return rawMeta;
  const executionRaw = rawMeta.execution;
  if (executionRaw === undefined || executionRaw === null) {
    // meta.execution explicitly null: strip it and pass the rest through.
    const { execution, ...rest } = rawMeta;
    return rest;
  }
  const normalized = normalizeExecution(executionRaw);
  if (normalized === null) {
    const { execution, ...rest } = rawMeta;
    return rest;
  }
  return { ...rawMeta, execution: normalized };
}

// Pull the contract (normalized) from a node, or null if absent.
export function executionContractFor(state, id) {
  const node = state && state.nodes ? state.nodes[id] : null;
  if (!node || !node.meta || typeof node.meta !== "object") return null;
  if (!("execution" in node.meta)) return null;
  const raw = node.meta.execution;
  if (raw === undefined || raw === null) return null;
  try {
    return normalizeExecution(raw);
  } catch {
    // A corrupt persisted contract must not break context. Surface null and
    // let the caller fall back; the mutating commands already validated on
    // write so this branch is purely defensive.
    return null;
  }
}
