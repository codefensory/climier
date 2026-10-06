
import path from "node:path";

import {
  PluginAgentMissing,
  PluginHandlerFailed,
  PluginSubcommandNotFound,
  isPluginError,
} from "./errors.ts";
import { loadInstalledPlugin } from "./loader.ts";
import { assertLocalBackend } from "./remote-guard.ts";

const BOOLEAN_FLAGS = new Set(["all", "force"]);

function consumedFlagValue(argv, index, token) {
  const eq = token.indexOf("=");
  const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
  if (BOOLEAN_FLAGS.has(key) || eq !== -1) {
    return false;
  }
  const next = argv[index + 1];
  return next !== undefined && !String(next).startsWith("--");
}

function findSubcommandIndex(argv, startIndex) {
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

function findNamespaceIndex(argv, namespace) {
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

export function findStripIndices(argv, namespace) {
  const namespaceIndex = findNamespaceIndex(argv, namespace);
  if (namespaceIndex === -1) {
    return [];
  }
  const subcommandIndex = findSubcommandIndex(argv, namespaceIndex);
  return subcommandIndex === -1 ? [namespaceIndex] : [namespaceIndex, subcommandIndex];
}

export function stripAtIndices(argv, indices) {
  if (!indices || indices.length === 0) {
    return argv.slice();
  }
  const set = new Set(indices);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (!set.has(i)) {
      out.push(argv[i]);
    }
  }
  return out;
}

export function findFirstFlagValue(argv, flagName) {
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

export function resolveEffectiveProjectDir(argv, fallback) {
  const v = findFirstFlagValue(argv || [], "project");
  if (v && String(v).trim()) {
    return path.resolve(String(v).trim());
  }
  return fallback;
}

export function resolveEffectiveAgent(argv, namespace) {
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

function placeholderApiFactory({ projectDir, agent, pluginId }) {
  const notImpl = (key) => () => {
    throw new PluginHandlerFailed(
      pluginId,
      "(dispatch)",
      new Error(`api.${key} not implemented yet (plugin API unavailable)`),
    );
  };
  return {
    runtime: {
      project_dir: projectDir,
      agent,
      plugin_id: pluginId,
    },
    query: {
      node: notImpl("query.node"),
      context: notImpl("query.context"),
      status: notImpl("query.status"),
      history: notImpl("query.history"),
    },
    data: {
      node: { get: notImpl("data.node.get"), set: notImpl("data.node.set") },
      project: { get: notImpl("data.project.get"), set: notImpl("data.project.set") },
    },
  };
}

let apiFactory = null;
let apiFactoryResolved = false;
async function loadApiFactory() {
  if (apiFactoryResolved) {
    return apiFactory;
  }
  try {
    const mod = await import("./api.ts");
    if (mod && typeof mod.createApi === "function") {
      apiFactory = mod.createApi;
    }
  } catch {

  }
  apiFactoryResolved = true;
  if (!apiFactory) {
    apiFactory = placeholderApiFactory;
  }
  return apiFactory;
}

function resetApiFactoryForTests() {
  apiFactory = null;
  apiFactoryResolved = false;
}

export { resetApiFactoryForTests as _resetApiFactoryForTests };

function validateSubcommand(commands, namespace, subcommand) {
  if (!subcommand || typeof subcommand !== "string" || typeof commands[subcommand] !== "function") {
    throw new PluginSubcommandNotFound(namespace, subcommand ?? null);
  }
}

async function invokePluginHandler({ commands, subcommand, namespace, tokens, api }) {
  try {
    return await commands[subcommand](tokens, api);
  } catch (err) {
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
  flags = {}, // eslint-disable-line no-unused-vars
  createApi: createApiInjected,
  backendClient,
} = {}) {
  assertLocalBackend(backendClient, "dispatchPlugin");
  const { pluginId, commands } = await loadInstalledPlugin(namespace);
  const argv = originalArgv || [];
  const indices = findStripIndices(argv, namespace);
  const subcommand = indices.length >= 2 ? argv[indices[1]] : null;
  validateSubcommand(commands, namespace, subcommand);
  const forwardedTokens = stripAtIndices(argv, indices);
  const effectiveProjectDir = resolveEffectiveProjectDir(originalArgv, projectDir);
  const agent = resolveEffectiveAgent(originalArgv, namespace);
  const createApi = createApiInjected || (await loadApiFactory());
  const api = createApi({ projectDir: effectiveProjectDir, agent, pluginId, backendClient });
  return invokePluginHandler({ commands, subcommand, namespace, tokens: forwardedTokens, api });
}
