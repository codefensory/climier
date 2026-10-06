import { randomUUID } from "node:crypto";
import addNode from "../add-node.ts";
import { throwV2 } from "../../../contracts/errors.ts";
import type { CliFlags, CommandContext } from "../contracts.ts";

const ID_RE = /^[A-Za-z0-9_.-]+$/;

export function requireFields(command: string, flags: CliFlags, fields: readonly string[], allowEmpty: readonly string[] = []) {
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

export async function addV2Node(command: string, prefix: string, shape: Record<string, string>, ctx: Omit<CommandContext, "command" | "originalArgv" | "projectConfig">) {
  const supplied = ctx.positional[0];
  const id = supplied || `${prefix}-${randomUUID().slice(0, 8)}`;
  if (supplied && !ID_RE.test(supplied)) {
    throwV2("INVALID_ID" as Parameters<typeof throwV2>[0], `${command}: id '${supplied}' is invalid (must match ${ID_RE})`, {
      id: supplied,
      pattern: ID_RE.source,
      command,
    });
  }
  return addNode({
    ...ctx,
    positional: [id],
    flags: { ...ctx.flags, ...shape },
    projectDir: ctx.projectDir,
    backendClient: ctx.backendClient,
    source: ctx.source,
    createCommand: command,
  });
}

export async function addNodeInternal({
  statePath,
  flags,
  positional,
  pluginId,
  backendClient,
  source,
  projectDir,
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
    backendClient,
    source,
    projectDir,
    createCommand: "add-node",
  });
}
