// Resolve project paths and global climier storage.
import os from "node:os";
import path from "node:path";

export function resolveProject({ project } = {}) {
  return project ? path.resolve(project) : process.cwd();
}

export function climierHome() {
  const home = process.env.CLIMIER_HOME;
  return path.resolve(home || path.join(os.homedir(), ".climier"));
}

export function projectMetaFile(projectDir) {
  return path.join(projectDir, ".climier.json");
}

export function legacyTasksDir(projectDir) {
  return path.join(projectDir, ".agents", "tasks");
}

export function legacyStateFile(projectDir) {
  return path.join(legacyTasksDir(projectDir), "tasks.json");
}
