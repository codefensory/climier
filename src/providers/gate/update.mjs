// src/providers/gate/update.mjs — pure provider for `gate.update`.
//
// The CLI keeps one `update` surface, while the provider seam classifies a
// gate update as `gate.update`. This provider accepts the gate fields exposed
// by that surface and owns only domain/input planning plus draft patching.
// It never touches locks, persistence, logs, policy, commands, or revision.

import { throwV2 } from "../../contracts/errors.mjs";

const OP = "gate.update";
const LOG_ACTION = "update";
const GATE_KIND = "resolvable";
const GATE_SUBKIND = "gate";

// Keep this list aligned with the CLI update command's gate-usable patch
// flags. `resolution_mode` is the typed API spelling of `--resolution-mode`.
const ALLOWED_PATCH_KEYS = new Set([
  "title",
  "body",
  "initiative",
  "domain",
  "tags",
  "refs",
  "meta",
  "definition",
  "acceptance",
  "backlog",
  "purpose",
  "resolution_mode",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNodes(snapshot) {
  return snapshot && isObject(snapshot.nodes) ? snapshot.nodes : {};
}

function validateInput(input) {
  if (!isObject(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    throwV2("MISSING_FIELD", `${OP}: id is required`, { field: "id" });
  }
  if (!isObject(input.changes) || Object.keys(input.changes).length === 0) {
    throwV2("MISSING_FIELD", `${OP}: changes must be a non-empty object`, { field: "changes" });
  }
  if (input.if_revision === undefined || input.if_revision === null) {
    throwV2("MISSING_FIELD", `${OP}: if_revision is required`, { field: "if_revision" });
  }
  const expected = Number(input.if_revision);
  if (!Number.isInteger(expected) || expected < 1) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: if_revision must be a positive integer`, {
      field: "if_revision",
      value: input.if_revision,
    });
  }
  return { id: input.id.trim(), expected };
}

function validateTarget(snapshot, id) {
  const node = readNodes(snapshot)[id];
  if (!node) throwV2("NODE_NOT_FOUND", `${OP}: gate '${id}' not found`, { id });
  if (node.kind !== GATE_KIND || node.subkind !== GATE_SUBKIND) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: target '${id}' is not a gate`, {
      id,
      kind: node.kind,
      subkind: node.subkind || null,
      expectedKind: GATE_KIND,
      expectedSubkind: GATE_SUBKIND,
    });
  }
  return node;
}

function validatePatchKeys(changes) {
  if (Object.prototype.hasOwnProperty.call(changes, "revision")) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes must not carry 'revision'`, {
      field: "changes.revision",
    });
  }
  for (const key of Object.keys(changes)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${OP}: changes.${key} is not a valid gate patch key (allowed: ${Array.from(ALLOWED_PATCH_KEYS).sort().join(", ")})`,
        { field: `changes.${key}`, allowed: Array.from(ALLOWED_PATCH_KEYS).sort() },
      );
    }
  }
}

function csv(value, field) {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.${field} must be an array or CSV string`, {
      field: `changes.${field}`,
    });
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.${field}[${index}] must be a non-empty string`, {
        field: `changes.${field}`,
      });
    }
    return item.trim();
  });
}

function refs(value) {
  if (typeof value === "string") return csv(value, "refs").map((target) => ({ type: "external", target }));
  if (!Array.isArray(value)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.refs must be an array or CSV string`, {
      field: "changes.refs",
    });
  }
  return value.map((ref, index) => {
    if (typeof ref === "string" && ref.trim()) return { type: "external", target: ref.trim() };
    if (isObject(ref)) return structuredClone(ref);
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.refs[${index}] must be a reference object`, {
      field: "changes.refs",
    });
  });
}

function normalizePatch(changes) {
  const patch = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "tags") {
      patch.tags = csv(value, key);
    } else if (key === "refs") {
      patch.refs = refs(value);
    } else if (key === "backlog") {
      if (typeof value !== "boolean") {
        throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.backlog must be boolean`, {
          field: "changes.backlog",
          value,
        });
      }
      // The CLI treats --backlog=false as removing the optional field,
      // rather than persisting a false marker. undefined is omitted by the
      // JSON state writer while still making the draft differ from true.
      patch.backlog = value ? true : undefined;
    } else if (key === "meta") {
      if (!isObject(value)) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.meta must be an object`, { field: "changes.meta" });
      }
      patch.meta = structuredClone(value);
    } else {
      patch[key] = value;
    }
  }
  return Object.freeze(patch);
}

function validateRevision(node, id, expected) {
  if (!Number.isInteger(node.revision) || node.revision !== expected) {
    throwV2("REVISION_CONFLICT", `${OP}: gate '${id}' changed since revision ${expected}`, {
      id,
      expected,
      current: Number.isInteger(node.revision) ? node.revision : null,
    });
  }
}

export async function prepare({ snapshot, input, request }) {
  void request;
  const { id, expected } = validateInput(input);
  const node = validateTarget(snapshot, id);
  validateRevision(node, id, expected);
  validatePatchKeys(input.changes);

  return Object.freeze({
    target: Object.freeze({ id, kind: GATE_KIND, subkind: GATE_SUBKIND, revision: expected }),
    policyAction: Object.freeze({ action: OP, pluginId: null }),
    logAction: LOG_ACTION,
    patch: normalizePatch(input.changes),
    if_revision: Object.freeze({ kind: "single", id, value: expected }),
  });
}

export async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.getNode !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: apply requires a tx with updateNode/getNode accessors`, {
      field: "tx",
    });
  }
  tx.updateNode(plan.target.id, plan.patch);
  const result = tx.getNode(plan.target.id);
  if (result && Object.prototype.hasOwnProperty.call(result, "revision")) delete result.revision;
  return { result, effects: null };
}

export const gateUpdateProvider = Object.freeze({ prepare, apply });
