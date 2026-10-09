
import { PluginInvalidDescriptor } from "../../plugins/descriptor.ts";

export const RESERVED_NAMESPACES = Object.freeze([

  "status",
  "context",
  "search",
  "history",
  "show",
  "initiatives",
  "log",
  "snapshots",
  "state",
  "migrate",
  "batch",

  "take",
  "submit",
  "accept",
  "reject",
  "resolve",
  "release",
  "cancel",
  "reopen",
  "update",
  "add-note",

  "add-initiative",
  "add-task",
  "add-gate",
  "add-knowledge",
  "deprecate-knowledge",
  "add-node",
  "add-edge",
  "remove-edge",

  "init",
  "server",
  "restore",
  "ui",
  "urls",
  "help",
  "version",
  "upgrade",

  "install",
  "uninstall",
]);

export class PluginNamespaceCollision extends PluginInvalidDescriptor {
  constructor(command, extra = {}) {
    super(
      `reserved-namespaces: command '${command ?? ""}' collides with a reserved core namespace`,
      { command: command ?? null, reserved: [...RESERVED_NAMESPACES], ...extra },
    );
  }
}

export function assertNoReservedCollision(command) {
  if (typeof command !== "string" || !command.trim()) {
    throw new PluginNamespaceCollision(command ?? null, { reason: "missing-or-empty" });
  }
  if (RESERVED_NAMESPACES.includes(command)) {
    throw new PluginNamespaceCollision(command);
  }
  return true;
}
