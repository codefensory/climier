import { randomUUID } from "node:crypto";
import addNode from "../add-node.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";

const ID_RE = /^[A-Za-z0-9_.-]+$/;

export function requireFields(command, flags, fields, allowEmpty = []) {
  for (const field of fields) {
    const value = flags[field];
    if (typeof value !== "string" || (!allowEmpty.includes(field) && !value.trim())) {
      const hint = allowEmpty.includes(field)
        ? ` (use --${field} "" for an explicit empty value)`
        : "";
      throwV2("MISSING_FIELD", `${command}: --${field} required${hint}`, { field, command });
    }
  }
}

export function hasCsvValue(value) {
  return typeof value === "string" && value.split(",").some((part) => part.trim());
}

export async function addV2Node(command, prefix, shape, ctx) {
  const supplied = ctx.positional[0];
  const id = supplied || `${prefix}-${randomUUID().slice(0, 8)}`;
  if (supplied && !ID_RE.test(supplied)) {
    throwV2("INVALID_ID", `${command}: id '${supplied}' is invalid (must match ${ID_RE})`, {
      id: supplied,
      pattern: ID_RE.source,
      command,
    });
  }
  return addNode({
    ...ctx,
    positional: [id],
    flags: { ...ctx.flags, ...shape },
  });
}

// Internal capability (ADR-008 §"Capacidad interna").
//
// addNodeInternal lets a privileged in-process caller (recovery imports,
// bulk migration tooling, future bootstrap paths) bypass the
// INITIATIVE_NOT_FOUND guard without exposing `--allow-unregistered-initiative`
// on the public CLI surface. The flag is fixed internally by this wrapper;
// the bin's `knownFlags` check rejects any user-supplied occurrence of
// the flag (handlers consume `flags["allow-unregistered-initiative"]`
// only when this wrapper sets it).
//
// Contract:
//   - allowUnregisteredInitiative: false (default) → equivalent to
//     addNode (no internal escape hatch).
//   - allowUnregisteredInitiative: true            → INITIATIVE_NOT_FOUND
//     is suppressed; the node is appended regardless of whether
//     `initiative` was registered.
//   - No other behaviour changes (the seam still runs, validation still
//     runs, log entry is still appended).
//
// The wrapper is intentionally not exposed on the public CLI/API
// surface: no public handler wraps it, no plugin receives it, and the
// flag it sets is not in `add-task.mjs`/`add-node.mjs` `knownFlags`.
export async function addNodeInternal({
  statePath,
  flags,
  positional,
  pluginId,
  allowUnregisteredInitiative = false,
}) {
  return addNode({
    statePath,
    flags: {
      ...flags,
      "allow-unregistered-initiative": allowUnregisteredInitiative,
    },
    positional,
    pluginId,
  });
}
