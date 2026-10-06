
import { throwV2 } from "../contracts/errors.ts";

export function resolveAgent(flags, commandName) {
  const fromFlag = flags && typeof flags.as === "string" ? flags.as.trim() : "";
  if (fromFlag) {return fromFlag;}

  const fromEnv = typeof process.env.CLIMIER_AGENT === "string"
    ? process.env.CLIMIER_AGENT.trim()
    : "";
  if (fromEnv) {return fromEnv;}

  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (pass --as <agent> or set CLIMIER_AGENT)`,
    { command: commandName, flag: "as", env: "CLIMIER_AGENT" },
  );
}

export const resolveActor = resolveAgent;
