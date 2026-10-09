
import fsSync from "node:fs";
import {
  COMMANDS,
  HELP_TEXT,
  KNOWN_COMMANDS,
  LOCAL_ONLY_COMMANDS,
  PACKAGE_VERSION,
  REMOTE_SUPPORTED_COMMANDS,
} from "./dispatch-constants.ts";
import { parseArgv, formatError, formatOutput } from "./dispatch-parser.ts";
export { COMMANDS, HELP_TEXT, KNOWN_COMMANDS, PACKAGE_VERSION } from "./dispatch-constants.ts";
export { parseArgv, formatError, formatOutput } from "./dispatch-parser.ts";
import { resolveProject, projectMetaFile } from "../storage/paths.ts";
import { createBackendClient } from "../application/operations/index.ts";
import { getOperationSource } from "../operation-source.ts";
import { asCaughtError, exitCodeForError, normalizeCliError } from "../contracts/errors.ts";
import { RESERVED_NAMESPACES } from "./commands/reserved-namespaces.ts";
import type { CommandContext, DispatchOptions } from "./commands/contracts.ts";
export type { CommandContext, CommandModule } from "./commands/contracts.ts";

type CliRunOptions = {
  argv?: string[];
  write?: (value: string) => void;
  exit?: (code: number) => void;
  source?: CommandContext["source"];
  createBackendClient?: typeof createBackendClient;
  dispatch?: (context: CommandContext) => Promise<unknown>;
};


function remoteUnsupported(command, reason = "is not supported by the remote backend") {
  const error = new Error(`dispatch: ${command || "no command"} ${reason}`);
  error.code = "REMOTE_UNSUPPORTED_OPERATION";
  error.details = { command: command ?? null };
  return error;
}

function requireRemoteProjectId(message) {
  const error = new Error(message);
  error.code = "REMOTE_PROJECT_ID_REQUIRED";
  error.details = { field: "project_id" };
  throw error;
}

function ensureRemoteProjectId(command, projectConfig, flags) {
  if (command === "init") {
    if (flags.force) {
      throw remoteUnsupported(command, "--force is not supported by the remote backend");
    }
    if (!projectConfig.project_id) {
      requireRemoteProjectId("dispatch: remote init requires project_id");
    }
  }
}

function ensureRemoteCommandSupported({ command, flags = {}, projectConfig = {}, backendClient }) {
  if (command === null || backendClient?.type !== "remote") {
    return;
  }
  if (!REMOTE_SUPPORTED_COMMANDS.has(command)) {
    throw remoteUnsupported(command);
  }
  ensureRemoteProjectId(command, projectConfig, flags);
}

function ensureCommandSupported(options) {
  if (!LOCAL_ONLY_COMMANDS.has(options.command ?? "")) {
    ensureRemoteCommandSupported(options);
  }
}

function shouldAddBackendContext(command) {
  return command !== "link" && !LOCAL_ONLY_COMMANDS.has(command ?? "");
}

function writeCommandResult(result, command, write, exit) {
  if (result !== undefined) {
    write(command === "version" && typeof result === "string" ? result : formatOutput(result));
  }
  if (command === "server" && result && typeof result === "object" && result.ok === false) {
    exitWith(exit, 1);
    return 1;
  }
  return 0;
}

function readProjectConfig(projectDir: string): Record<string, unknown> {
  const file = projectMetaFile(projectDir);
  if (!fsSync.existsSync(file)) {
    return {};
  }
  let config;
  try {
    config = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (caught) {
    const cause = asCaughtError(caught);
    const error = new Error(`state: project metadata at ${file} is corrupt or not valid JSON: ${cause.message}`);
    error.code = "CLIMIER_CORRUPT_PROJECT_META";
    error.cause = cause;
    throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || typeof config.project_id !== "string" || !config.project_id.trim()) {
    const error = new Error(`state: project metadata at ${file} is invalid (missing non-empty 'project_id')`);
    error.code = "CLIMIER_CORRUPT_PROJECT_META";
    throw error;
  }
  return config;
}

function validateKnownFlags(command, flags, knownFlags) {
  if (!Array.isArray(knownFlags)) {
    return;
  }
  const allowed = new Set([...knownFlags, "project", "no-warnings"]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      const sorted = [...allowed].filter((name) => name !== "project" && name !== "no-warnings").toSorted();
      const error = new Error(`${command}: unknown flag --${key} (valid flags: --${sorted.join(", --")})`);
      error.code = "CLI_USAGE_ERROR";
      error.details = { command, flag: key, valid_flags: sorted };
      throw error;
    }
  }
}

async function dispatchInstalledPlugin({
  command,
  originalArgv,
  flags,
  projectDir,
  backendClient,
  dispatchPluginInjected,
  hasInstalledPluginInjected,
}) {
  if (command === null || RESERVED_NAMESPACES.includes(command) || KNOWN_COMMANDS.includes(command)) {
    return undefined;
  }
  const hasInstalledPlugin = hasInstalledPluginInjected
    || (await import("../plugins/loader.ts")).hasInstalledPlugin;
  const dispatchPlugin = dispatchPluginInjected
    || (await import("../plugins/dispatch.ts")).dispatchPlugin;
  if (!(await hasInstalledPlugin(command))) {
    return undefined;
  }
  return dispatchPlugin({ originalArgv, namespace: command, projectDir, flags, backendClient });
}

function isCommandModule(value: unknown): value is { knownFlags?: readonly string[]; default: (context: CommandContext) => unknown } {
  return value !== null && typeof value === "object"
    && typeof (value as { default?: unknown }).default === "function";
}

async function dispatchBuiltInCommand(context: CommandContext) {
  const load = COMMANDS[context.command];
  if (!load) {
    const error = new Error(`unknown command '${context.command}'`);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  const loaded = await load();
  if (!isCommandModule(loaded)) {
    throw new Error(`command '${context.command}' does not export a default handler`);
  }
  validateKnownFlags(context.command, context.flags, loaded.knownFlags);
  return loaded.default(context);
}

function optionOr(value, fallback) {
  return value === undefined ? fallback : value;
}

function dispatchContext(options: DispatchOptions = {}) {
  const projectDir = optionOr(options.projectDir, "");
  return {
    command: optionOr(options.command, null),
    originalArgv: optionOr(options.originalArgv, []),
    flags: optionOr(options.flags, {}),
    positional: optionOr(options.positional, []),
    projectDir,
    statePath: optionOr(options.statePath, projectDir),
    projectConfig: optionOr(options.projectConfig, {}),
    backendClient: options.backendClient,
    source: options.source,
    dispatchPluginInjected: options.dispatchPlugin,
    hasInstalledPluginInjected: options.hasInstalledPlugin,
  };
}

async function dispatchSelectedCommand(context) {
  const pluginResult = await dispatchInstalledPlugin(context);
  if (pluginResult !== undefined) {
    return pluginResult;
  }
  return dispatchBuiltInCommand({ ...context, command: context.command ?? "" });
}

export async function dispatchCommand(options: DispatchOptions = {}) {
  const context = dispatchContext(options);
  ensureCommandSupported(context);
  return dispatchSelectedCommand(context);
}

function exitWith(exit, code) {
  exit(code);
}

function writeHelpResponse(write, exit) {
  write(HELP_TEXT);
  exitWith(exit, 0);
  return 0;
}

function writeVersionResponse(write, exit) {
  write(PACKAGE_VERSION);
  exitWith(exit, 0);
  return 0;
}

function hasCommandBeforeVersion(args, versionIndex) {
  for (let index = 0; index < versionIndex; index += 1) {
    const token = args[index];
    if (token === "--project" && index + 1 < versionIndex) {
      index += 1;
      continue;
    }
    if (typeof token === "string" && !token.startsWith("--")) {
      return true;
    }
  }
  return false;
}

function hasVersionFlag(args) {
  const versionIndex = args.indexOf("--version");
  return versionIndex !== -1 && !hasCommandBeforeVersion(args, versionIndex);
}

function writeEarlyResponse(args, write, exit) {
  if (args.includes("--help") || args.includes("-h")) {
    return writeHelpResponse(write, exit);
  }
  if (hasVersionFlag(args)) {
    return writeVersionResponse(write, exit);
  }
  return null;
}

function writeBuiltInResponse(command, write, exit) {
  if (command === "help") {
    return writeHelpResponse(write, exit);
  }
  return null;
}

function writeNoCommandResponse(command, write, exit) {
  if (command) {
    return null;
  }
  const error = new Error("no command given");
  error.code = "CLI_USAGE_ERROR";
  error.details = { command: null, valid_commands: [...KNOWN_COMMANDS].toSorted() };
  write(formatError(normalizeCliError(error)));
  exitWith(exit, 2);
  return 2;
}

function isRemoteProjectConfig(projectConfig) {
  const backend = projectConfig.backend;
  return backend && typeof backend === "object" && !Array.isArray(backend)
    && (backend as { type?: unknown }).type === "remote";
}

async function operationSourceForContext(source, isRemote) {
  if (source !== undefined && source !== null) {
    return source;
  }
  if (isRemote) {
    return undefined;
  }
  return getOperationSource();
}

async function completeOperationSource(source, backendClient) {
  if (source === undefined || source === null) {
    if (backendClient?.type === "local") {
      return backendClient.operationSource;
    }
  }
  return source;
}

async function addBackendContext(context, { source, backendClientFactory }) {
  const projectConfig = readProjectConfig(context.projectDir);
  const localSource = await operationSourceForContext(source, isRemoteProjectConfig(projectConfig));
  const backendClient = backendClientFactory({
    projectDir: context.projectDir,
    projectConfig,
    source: localSource,
    command: context.command,
  });
  const selectedSource = await completeOperationSource(localSource, backendClient);
  Object.assign(context, { projectConfig, backendClient, source: selectedSource });
  ensureRemoteCommandSupported({ ...context, backendClient });
  return context;
}

function writeCliError(error, command, write, exit) {
  if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") {
    const usageError = new Error(`unknown command '${command}'`);
    usageError.code = "CLI_USAGE_ERROR";
    usageError.details = { command, valid_commands: [...KNOWN_COMMANDS].toSorted() };
    error = usageError;
  }
  write(formatError(normalizeCliError(error)));
  const code = exitCodeForError(error);
  exitWith(exit, code);
  return code;
}

async function executeParsedCli({ parsed, context, source, backendClientFactory, dispatchCommandFn, write, exit }) {
  try {
    const builtInResponse = writeBuiltInResponse(parsed.command, write, exit);
    if (builtInResponse !== null) {
      return builtInResponse;
    }
    const noCommandResponse = writeNoCommandResponse(parsed.command, write, exit);
    if (noCommandResponse !== null) {
      return noCommandResponse;
    }
    if (shouldAddBackendContext(parsed.command)) {
      await addBackendContext(context, { source, backendClientFactory });
    }
    const result = await dispatchCommandFn(context);
    return writeCommandResult(result, parsed.command, write, exit);
  } catch (error) {
    return writeCliError(error, parsed.command, write, exit);
  }
}

function cliOptions(options: CliRunOptions = {}) {
  return {
    argv: options.argv ?? process.argv.slice(2),
    write: options.write ?? console.log,
    exit: options.exit ?? process.exit,
    source: options.source,
    backendClientFactory: options.createBackendClient ?? createBackendClient,
    dispatchCommandFn: options.dispatch ?? dispatchCommand,
  };
}

async function runCliWithOptions(options: CliRunOptions = {}) {
  const { argv, write, exit, source, backendClientFactory, dispatchCommandFn } = cliOptions(options);
  const args = Array.isArray(argv) ? argv.slice() : [];
  const earlyResponse = writeEarlyResponse(args, write, exit);
  if (earlyResponse !== null) {
    return earlyResponse;
  }

  const parsed = parseArgv(args);
  const projectDir = resolveProject({ project: parsed.flags.project as string | undefined });
  const context = { ...parsed, projectDir, statePath: projectDir } as CommandContext;
  return executeParsedCli({ parsed, context, source, backendClientFactory, dispatchCommandFn, write, exit });
}

export const runCli = runCliWithOptions;
