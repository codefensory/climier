import fsSync from "node:fs";
import { resolveProject } from "../storage/paths.ts";
import { pluginRuntimeDataDir } from "./paths.ts";
import { assertLocalBackend } from "./remote-guard.ts";
import type { PluginBackendClient, PluginRuntime } from "./types.ts";

const VALUE_FLAGS = new Set(["project", "as"]);

type FlagValue = string | boolean;
type FlagEntry = [Record<string, FlagValue>, number];

function flagEntry(argv: unknown[], index: number): FlagEntry | null {
  const token = argv[index];
  if (typeof token !== "string" || !token.startsWith("--")) {
    return null;
  }
  const eq = token.indexOf("=");
  const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
  if (eq !== -1) {
    return [{ [key]: token.slice(eq + 1) }, index];
  }
  const next = argv[index + 1];
  if (VALUE_FLAGS.has(key) && typeof next === "string" && !next.startsWith("--")) {
    return [{ [key]: next }, index + 1];
  }

  return [{ [key]: true }, index];
}

export function parseFlags(argv: unknown): Record<string, FlagValue> {
  const flags: Record<string, FlagValue> = {};
  if (!Array.isArray(argv)) {
    return flags;
  }
  for (let i = 0; i < argv.length; i++) {
    const entry = flagEntry(argv, i);
    if (!entry) {
      continue;
    }
    const [values, lastIndex] = entry;
    Object.assign(flags, values);
    i = lastIndex;
  }
  return flags;
}

export function resolveRuntime(argv: unknown): { project_dir: string; agent: string } {
  const flags = parseFlags(argv);
  const projectFlag = flags.project;
  const projectInput = typeof projectFlag === "string" && projectFlag !== "" ? projectFlag : undefined;
  const project_dir = resolveProject({ project: projectInput });
  const asFlag = flags.as;
  const fromFlag = typeof asFlag === "string" ? asFlag.trim() : "";
  const fromEnv = typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  const agent = fromFlag || fromEnv;
  return { project_dir, agent };
}

export function createRuntime({ projectDir, agent, pluginId, backendClient }: {
  projectDir?: unknown;
  agent?: unknown;
  pluginId?: unknown;
  backendClient: PluginBackendClient;
} = { backendClient: undefined as unknown as PluginBackendClient }): PluginRuntime {
  assertLocalBackend(backendClient, "createRuntime");
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createRuntime: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createRuntime: pluginId required");
  }

  const dataDir = pluginRuntimeDataDir(projectDir, pluginId);
  try {
    fsSync.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `createRuntime: unable to create runtime data directory at ${dataDir}: ${message}`,
      { cause: err },
    );
    wrapped.code = "PLUGIN_RUNTIME_UNAVAILABLE";
    wrapped.details = { plugin_id: pluginId, data_dir: dataDir, cause: message };
    throw wrapped;
  }

  return {
    project_dir: projectDir,
    agent: typeof agent === "string" ? agent : "",
    dataDir,
  };
}
