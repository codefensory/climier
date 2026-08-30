// F8 — agent source resolution for v2 mutating commands.
//
// Precedence: flags.as (non-empty string) > process.env.CLIMIER_AGENT
// (non-empty string) > MISSING_AGENT. The boolean edge case (--as parsed as
// `true` because the next argv was missing) is rejected explicitly so it
// does not silently fall through to the env var.
import { throwV2 } from "./errors.mjs";

export function resolveAgent(flags, commandName) {
  const fromFlag = flags && typeof flags.as === "string" ? flags.as.trim() : "";
  if (fromFlag) return fromFlag;
  const fromEnv = typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  if (fromEnv) return fromEnv;
  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (pass --as <agent> or set CLIMIER_AGENT)`,
    { command: commandName, flag: "as", env: "CLIMIER_AGENT" },
  );
}