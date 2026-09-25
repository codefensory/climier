import { installTransferDestination } from "../../kernel/transfer.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";

export const knownFlags = ["as", "overwrite"];

function overwriteOption(value) {
  if (value === undefined || value === "false") return false;
  if (value === true || value === "true") return true;
  throwV2("INVALID_REQUEST", "pull: --overwrite must be true or false", { field: "overwrite" });
}

export default async function pull({ projectDir, statePath, projectConfig = {}, backendClient, flags = {}, positional = [] }) {
  if (positional.length) throwV2("INVALID_REQUEST", "pull: positional arguments are not allowed", { field: "positional" });
  if (backendClient?.type !== "remote") {
    const error = new Error("pull: requires a configured remote backend");
    error.code = "REMOTE_UNSUPPORTED_OPERATION";
    throw error;
  }
  if (typeof projectConfig.project_id !== "string" || !projectConfig.project_id.trim()) {
    const error = new Error("pull: remote backend requires project_id");
    error.code = "REMOTE_PROJECT_ID_REQUIRED";
    throw error;
  }
  const actor = resolveAgent(flags, "pull");
  const overwrite = overwriteOption(flags.overwrite);
  const payload = await backendClient.exportTransfer();
  return installTransferDestination({
    destinationProjectDir: projectDir || statePath,
    payload,
    actor,
    direction: "pull",
    overwrite,
  });
}
