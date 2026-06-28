// Resolve the project directory. By default uses CWD; --project overrides.
import path from "node:path";

export function resolveProject({ project } = {}) {
  return project ? path.resolve(project) : process.cwd();
}
