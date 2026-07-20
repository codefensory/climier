import { randomUUID } from "node:crypto";
import addNode from "./commands/add-node.mjs";
import { throwV2 } from "./errors.mjs";

const ID_RE = /^[A-Za-z0-9_.-]+$/;

export function requireFields(command, flags, fields, allowEmpty = []) {
  for (const field of fields) {
    const value = flags[field];
    if (typeof value !== "string" || (!allowEmpty.includes(field) && !value.trim())) {
      throwV2("MISSING_FIELD", `${command}: --${field} required`, { field, command });
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
