import { captureTransferSource } from "../../kernel/transfer.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";

export const knownFlags = ["as", "overwrite"];

function overwriteOption(value, command) {
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throwV2("INVALID_REQUEST", `${command}: --overwrite must be true or false`, { field: "overwrite" });
}

export default async function push({ projectDir, statePath, projectConfig = {}, backendClient, flags = {}, positional = [] }) {
  if (positional.length) throwV2("INVALID_REQUEST", "push: positional arguments are not allowed", { field: "positional" });
  if (backendClient?.type !== "remote") {
    const error = new Error("push: requires a configured remote backend");
    error.code = "REMOTE_UNSUPPORTED_OPERATION";
    throw error;
  }
  if (typeof projectConfig.project_id !== "string" || !projectConfig.project_id.trim()) {
    const error = new Error("push: remote backend requires project_id");
    error.code = "REMOTE_PROJECT_ID_REQUIRED";
    throw error;
  }
  const actor = resolveAgent(flags, "push");
  const overwrite = overwriteOption(flags.overwrite, "push");
  const payload = await captureTransferSource({ sourceProjectDir: projectDir || statePath });
  return backendClient.importTransfer({ payload, actor, overwrite });
}
