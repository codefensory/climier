import { pushManualTransfer } from "../../application/manual-transfer.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["as", "force"];

function usage(message, details) {
  const error = new Error(`push: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  if (details !== undefined) {error.details = details;}
  return error;
}

function requestOptions({ positional, flags, projectDir, projectConfig, backendClient, originalArgv }: Pick<CommandContext, "positional" | "flags" | "projectDir" | "projectConfig" | "backendClient" | "originalArgv">) {
  const commandIndex = originalArgv.indexOf("push");
  if (commandIndex >= 0 && originalArgv.slice(0, commandIndex).some((token) => token === "--force" || token.startsWith("--force="))) {
    throw usage("--force must appear after push", { flag: "force" });
  }
  if (positional.length) {
    throw usage("does not accept positional arguments", { positional_count: positional.length });
  }
  if (typeof flags.as !== "string" || !flags.as.trim()) {
    throw usage("--as <actor> is required", { flag: "as" });
  }
  if (flags.force !== undefined && flags.force !== true) {
    throw usage("--force must be a bare boolean flag", { flag: "force" });
  }
  return {
    projectDir,
    projectConfig,
    backendClient,
    actor: flags.as.trim(),
    force: flags.force === true,
  };
}

function withActionableConflict(caught: unknown) {
  const error = asCaughtError(caught);
  if (["TRANSFER_REMOTE_CHANGED", "TRANSFER_LOCAL_CHANGED", "TRANSFER_BASE_UNKNOWN"].includes(error.code || "")) {
    error.message = `${error.message}; choose explicitly: pull --force keeps the remote DAG and replaces local state, while push --force keeps the local DAG and replaces remote state`;
  }
  return error;
}

export default async function push(options: Pick<CommandContext, "positional" | "flags" | "projectDir" | "projectConfig" | "backendClient" | "originalArgv">) {
  try {
    return await pushManualTransfer(requestOptions(options));
  } catch (error) {
    throw withActionableConflict(error);
  }
}
