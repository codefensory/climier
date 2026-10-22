
import { PluginInvalidDescriptor } from "../../plugins/descriptor.ts";
import { RESERVED_NAMESPACES } from "./reserved-namespaces-list.ts";

export { RESERVED_NAMESPACES };

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
