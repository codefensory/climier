// Reserved core CLI namespaces.
//
// Mirrors the command list in bin/climier.mjs HELP_TEXT plus the meta
// commands (`help`, `version`) and the lifecycle pair (`install`,
// `uninstall`). Plugin `command` values must not collide with these; the
// dispatch layer reuses the same list to decide
// between core and plugin namespaces.
//
// Uniqueness invariant: every entry appears exactly once. The
// plugin-install.test.mjs suite asserts it.

import { PluginInvalidDescriptor } from "../../plugins/descriptor.mjs";

export const RESERVED_NAMESPACES = Object.freeze([
  // Read-only commands.
  "status",
  "context",
  "search",
  "history",
  "show",
  "initiatives",
  "log",
  "snapshots",
  "state",
  "batch",
  // Mutating claim/lifecycle commands.
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
  // DAG construction commands.
  "add-initiative",
  "add-task",
  "add-gate",
  "add-knowledge",
  "deprecate-knowledge",
  "add-node",
  "add-edge",
  "remove-edge",
  // Setup + meta commands.
  "init",
  "restore",
  "ui",
  "help",
  "version",
  // Lifecycle pair (this ADR).
  "install",
  "uninstall",
]);

// PLUGIN_INVALID_DESCRIPTOR: reserved-collision is treated as a
// descriptor failure because the descriptor's `command` field is what's
// colliding. We re-use the parent error class so consumers can
// `instanceof` against PluginInvalidDescriptor.
export class PluginNamespaceCollision extends PluginInvalidDescriptor {
  constructor(command, extra = {}) {
    super(
      `reserved-namespaces: command '${command ?? ""}' collides with a reserved core namespace`,
      { command: command ?? null, reserved: [...RESERVED_NAMESPACES], ...extra },
    );
  }
}

// assertNoReservedCollision: throws PLUGIN_INVALID_DESCRIPTOR if the
// plugin's `command` collides with a reserved core namespace or is
// missing/empty. Returns true on success.
export function assertNoReservedCollision(command) {
  if (typeof command !== "string" || !command.trim()) {
    throw new PluginNamespaceCollision(command ?? null, { reason: "missing-or-empty" });
  }
  if (RESERVED_NAMESPACES.includes(command)) {
    throw new PluginNamespaceCollision(command);
  }
  return true;
}
