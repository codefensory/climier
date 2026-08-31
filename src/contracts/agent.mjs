// Core actor contract.
//
// The kernel receives an actor selected by its host. Source resolution
// (--as/CLIMIER_AGENT) belongs to the CLI adapter and must not leak into this
// agnostic contract.
import { throwV2 } from "./errors.mjs";

export function requireAgent(actor, operation) {
  const value = typeof actor === "string" ? actor.trim() : "";
  if (value) return value;

  throwV2(
    "MISSING_AGENT",
    `${operation}: agent required`,
    { command: operation, field: "actor" },
  );
}
