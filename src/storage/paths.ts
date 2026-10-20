
import os from "node:os";
import path from "node:path";

export function resolveProject({ project }: { project?: string } = {}): string {
  return project ? path.resolve(project) : process.cwd();
}

export function climierHome(): string {
  const home = process.env.CLIMIER_HOME;
  return path.resolve(home || path.join(os.homedir(), ".climier"));
}

export function stateBackend(): "json" | "sqlite" {
  const backend = process.env.CLIMIER_STATE_BACKEND || "json";
  if (backend !== "json" && backend !== "sqlite") {
    throw new Error(`storage: unsupported CLIMIER_STATE_BACKEND '${backend}' (expected json or sqlite)`);
  }
  return backend;
}

export function sqliteStateFileForProjectId(projectId: string): string {
  return path.join(climierHome(), "projects", projectId, "state.sqlite");
}

export function projectMetaFile(projectDir) {
  return path.join(projectDir, ".climier.json");
}
