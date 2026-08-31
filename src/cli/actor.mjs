// CLI actor resolution.
//
// The command-line adapter is responsible for turning argv/environment
// identity into the actor passed to application operations. Core contracts
// consume an already resolved actor and do not need to know how it was
// selected.
import { throwV2 } from "../contracts/errors.mjs";

/**
 * Resolve the actor for a CLI command.
 *
 * Explicit --as wins over CLIMIER_AGENT. A boolean --as (the parser's value
 * for a flag with no argument) is deliberately treated as missing rather than
 * being coerced to the actor name "true".
 */
export function resolveAgent(flags, commandName) {
  const fromFlag = flags && typeof flags.as === "string" ? flags.as.trim() : "";
  if (fromFlag) return fromFlag;

  const fromEnv = typeof process.env.CLIMIER_AGENT === "string"
    ? process.env.CLIMIER_AGENT.trim()
    : "";
  if (fromEnv) return fromEnv;

  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (pass --as <agent> or set CLIMIER_AGENT)`,
    { command: commandName, flag: "as", env: "CLIMIER_AGENT" },
  );
}

export const resolveActor = resolveAgent;
