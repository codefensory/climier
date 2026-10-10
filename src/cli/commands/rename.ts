import { isValidProjectName, normalizeProjectName } from "../../contracts/project-name.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import { setProjectMetaName } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags: readonly string[] = [];

function renameError(code: string, message: string, details?: Record<string, unknown>) {
  const error = new Error(`rename: ${message}`);
  error.code = code;
  if (details !== undefined) { error.details = details; }
  return error;
}

function usage(message: string, details?: Record<string, unknown>) {
  return renameError("CLI_USAGE_ERROR", message, details);
}

function syncRemoteName(backendClient: CommandContext["backendClient"], name: string) {
  if (backendClient?.type !== "remote") { return Promise.resolve(); }
  const renameProject = backendClient.renameProject;
  if (typeof renameProject !== "function") { return Promise.resolve(); }
  return renameProject(name);
}

export default async function rename({ positional, projectDir, projectConfig, backendClient }: CommandContext) {
  if (positional.length !== 1) {
    throw usage("expected exactly one name", { positional_count: positional.length });
  }
  const raw = positional[0];
  if (!isValidProjectName(raw)) {
    throw usage("name must be a non-empty string of at most 120 characters", { field: "name" });
  }
  const projectId = typeof projectConfig.project_id === "string" ? projectConfig.project_id : "";
  if (!projectId) {
    throw renameError("CLIMIER_PROJECT_META_MISSING", "project metadata is missing; run climier init first", { file: projectDir });
  }
  const name = normalizeProjectName(raw) as string;
  await setProjectMetaName(projectDir, name);
  try {
    await syncRemoteName(backendClient, name);
  } catch (caught) {
    const error = asCaughtError(caught);
    error.message = `rename: local name set to "${name}", but the remote server did not accept it: ${error.message}`;
    throw error;
  }
  return { project: { project_id: projectId, name } };
}
