
import os from "node:os";
import path from "node:path";

export function resolveProject({ project }: { project?: string } = {}): string {
  return project ? path.resolve(project) : process.cwd();
}

export function climierHome(): string {
  const home = process.env.CLIMIER_HOME;
  return path.resolve(home || path.join(os.homedir(), ".climier"));
}

export function projectMetaFile(projectDir) {
  return path.join(projectDir, ".climier.json");
}
