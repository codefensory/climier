import path from "node:path";

import {
  PluginAgentMissing,
  PluginHandlerFailed,
  PluginSubcommandNotFound,
  isPluginError,
} from "./errors.ts";
import { loadInstalledPlugin } from "./loader.ts";
import { assertLocalBackend } from "./remote-guard.ts";
import type { ApiFactory, PluginApi, PluginBackendClient, PluginCommands } from "./types.ts";

const BOOLEAN_FLAGS = new Set(["all", "force"]);

type DispatchApiFactory = ApiFactory;

function consumedFlagValue(argv: string[], index: number, token: string): boolean {
  const eq = token.indexOf("=");
  const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
  if (BOOLEAN_FLAGS.has(key) || eq !== -1) {
    return false;
  }
  const next = argv[index + 1];
  return next !== undefined && !String(next).startsWith("--");
}

function findSubcommandIndex(argv: string[], startIndex: number): number {
  for (let i = startIndex + 1; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== "string" || !token) {
      continue;
    }
    if (token.startsWith("--")) {
      if (consumedFlagValue(argv, i, token)) {
        i++;
      }
      continue;
    }
    return i;
  }
  return -1;
}

function findNamespaceIndex(argv: string[], namespace: string): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== "string" || !token) {
      continue;
    }
    if (token.startsWith("--")) {
      if (consumedFlagValue(argv, i, token)) {
        i++;
      }
      continue;
    }
    if (token === namespace) {
      return i;
    }
  }
  return -1;
}

export function findStripIndices(argv: string[], namespace: string): number[] {
  const namespaceIndex = findNamespaceIndex(argv, namespace);
  if (namespaceIndex === -1) {
    return [];
  }
  const subcommandIndex = findSubcommandIndex(argv, namespaceIndex);
  return subcommandIndex === -1 ? [namespaceIndex] : [namespaceIndex, subcommandIndex];
}

export function stripAtIndices(argv: string[], indices: number[]): string[] {
  if (!indices || indices.length === 0) {
    return argv.slice();
  }
  const set = new Set(indices);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!set.has(i)) {
      out.push(argv[i]);
    }
  }
  return out;
}

export function findFirstFlagValue(argv: string[], flagName: string): string | null {
  const eqPrefix = `--${flagName}=`;
  const exact = `--${flagName}`;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string") {continue;}
    if (tok.startsWith(eqPrefix)) {
      return tok.slice(eqPrefix.length);
    }
    if (tok === exact) {
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {return next;}
      return null;
    }
  }
  return null;
}

export function resolveEffectiveProjectDir(argv: string[], fallback: string | undefined): string | undefined {
  const v = findFirstFlagValue(argv || [], "project");
  if (v && String(v).trim()) {
    return path.resolve(String(v).trim());
  }
  return fallback;
}

export function resolveEffectiveAgent(argv: string[], namespace: string): string {
  const v = findFirstFlagValue(argv || [], "as");
  const fromArgv = v && String(v).trim() ? String(v).trim() : "";
  if (fromArgv) {
    return fromArgv;
  }
  const fromEnv =
    typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  throw new PluginAgentMissing(namespace);
}

const notImplemented = (pluginId: string, key: string) => (..._args: unknown[]): never => {
  throw new PluginHandlerFailed(
    pluginId,
    "(dispatch)",
    new Error(`api.${key} not implemented yet (plugin API unavailable)`),
  );
};

function placeholderApiFactory({ projectDir, agent, pluginId }: {
  projectDir: string;
  agent: string;
  pluginId: string;
  backendClient: PluginBackendClient;
}): PluginApi {
  return {
    runtime: {
      project_dir: projectDir,
      agent,
      plugin_id: pluginId,
    },
    query: {
      node: notImplemented(pluginId, "query.node"),
      context: notImplemented(pluginId, "query.context"),
      status: notImplemented(pluginId, "query.status"),
      history: notImplemented(pluginId, "query.history"),
    },
    data: {
      node: { get: notImplemented(pluginId, "data.node.get"), set: notImplemented(pluginId, "data.node.set") },
      project: { get: notImplemented(pluginId, "data.project.get"), set: notImplemented(pluginId, "data.project.set") },
    },
  };
}

let apiFactory: DispatchApiFactory | null = null;
let apiFactoryResolved = false;
async function loadApiFactory(): Promise<DispatchApiFactory> {
  if (apiFactoryResolved) {
    return apiFactory || placeholderApiFactory;
  }
  try {
    const mod = await import("./api.ts");
    if (typeof mod.createApi === "function") {
      apiFactory = mod.createApi;
    }
  } catch {
    // The placeholder keeps dispatch errors within the plugin API contract.
  }
  apiFactoryResolved = true;
  if (!apiFactory) {
    apiFactory = placeholderApiFactory;
  }
  return apiFactory;
}

function resetApiFactoryForTests(): void {
  apiFactory = null;
  apiFactoryResolved = false;
}

export { resetApiFactoryForTests as _resetApiFactoryForTests };

function validateSubcommand(commands: PluginCommands, namespace: string, subcommand: unknown): asserts subcommand is string {
  if (!subcommand || typeof subcommand !== "string" || typeof commands[subcommand] !== "function") {
    throw new PluginSubcommandNotFound(namespace, typeof subcommand === "string" ? subcommand : null);
  }
}

async function invokePluginHandler({ commands, subcommand, namespace, tokens, api }: {
  commands: PluginCommands;
  subcommand: string;
  namespace: string;
  tokens: string[];
  api: PluginApi;
}): Promise<unknown> {
  try {
    return await commands[subcommand](tokens, api);
  } catch (err: unknown) {
    if (isPluginError(err)) {
      throw err;
    }
    throw new PluginHandlerFailed(namespace, subcommand, err);
  }
}

export async function dispatchPlugin({
  originalArgv,
  namespace,
  projectDir,
  flags = {},
  createApi: createApiInjected,
  backendClient,
}: {
  originalArgv?: string[];
  namespace?: string;
  projectDir?: string;
  flags?: Record<string, unknown>;
  createApi?: ApiFactory;
  backendClient: PluginBackendClient;
}): Promise<unknown> {
  assertLocalBackend(backendClient, "dispatchPlugin");
  if (typeof namespace !== "string" || !namespace) {
    throw new Error("dispatchPlugin: namespace required");
  }
  const { pluginId, commands } = await loadInstalledPlugin(namespace);
  const argv = originalArgv || [];
  const indices = findStripIndices(argv, namespace);
  const subcommand = indices.length >= 2 ? argv[indices[1]] : null;
  validateSubcommand(commands, namespace, subcommand);
  const forwardedTokens = stripAtIndices(argv, indices);
  const effectiveProjectDir = resolveEffectiveProjectDir(originalArgv || [], projectDir);
  if (!effectiveProjectDir) {
    throw new Error("dispatchPlugin: projectDir required");
  }
  const agent = resolveEffectiveAgent(originalArgv || [], namespace);
  const createApi = createApiInjected || (await loadApiFactory());
  const api = createApi({ projectDir: effectiveProjectDir, agent, pluginId, backendClient });
  return invokePluginHandler({ commands, subcommand, namespace, tokens: forwardedTokens, api });
}
