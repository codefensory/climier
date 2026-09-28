// CLI entry and dispatch adapter.
//
// This module owns argv parsing, command/plugin routing, output formatting,
// and process-level error handling. `bin/climier.mjs` intentionally remains a
// thin executable wrapper around runCli().
import fsSync from "node:fs";

import { resolveProject, projectMetaFile } from "../storage/paths.mjs";
import { createBackendClient } from "../application/operations/index.mjs";
import { exitCodeForError, normalizeCliError } from "../contracts/errors.mjs";
import { RESERVED_NAMESPACES } from "./commands/reserved-namespaces.mjs";

export const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export const HELP_TEXT = "climier — JSON-first task DAG CLI for coordinating work\n\nUse it when one or many actors need a shared source of truth for what is\nready, claimed, blocked, decided, backlog, done, or archived.\n\nCommon patterns:\n  solo / multi-session: status -> context -> take -> work -> submit -> accept\n  human + AI:           add-task -> context -> take -> add-note -> submit -> accept\n  with a policy plugin: see docs/PLUGINS.md (ADR-007/008); the core\n                        no longer recognises actor names like\n                        \"orchestrator\"/\"recovery\" as authority.\n\nUsage: climier [--project <dir>] <command> [args...]\n\nOutput: every command prints a single JSON value to stdout.\nErrors: { ok: false, error: { code, message, details } } on stdout, non-zero exit.\nExceptions: --help/-h/help and --version/version print plain text.\n\nRead-only:\n  status [--initiative X] [--kind task|gate|knowledge] [--status X] [--domain X]\n        [--claimed-by X] [--stale-ms N] [--limit N] [--all]\n                                          Summary-shape: task buckets (ready/in_progress/blocked/backlog), open gates, knowledge count, alerts.\n                                          in_progress is global by default: every in_progress task is listed and counted\n                                          regardless of caller. Use --claimed-by <agent> to narrow to one agent's claims.\n                                          --as is an identity tag (it scopes context's allowed_actions) and is not a filter\n                                          for status.\n  context <id>                           Agent-first view of a node: spec, blockers, informing edges, scoped knowledge, allowed actions.\n  search \"<query>\" [--all]               Search active knowledge; --all includes deprecated knowledge.\n  initiatives                            List registered initiatives with usage counts.\n  log [--limit N] [--action X] [--agent X] [--node X]\n                                          Show the audit log.\n  history <id> [--limit N]               Log entries that reference a node.\n  show <id>                              Print the raw node object.\n  snapshots                              List recoverable snapshots captured under <state-dir>/snapshots/, newest first.\n  state                                  Read the deterministic current core projection (not historical snapshots).\n  migrate [--project <dir>] [--all] [--dry-run]  Report detected state forms; dry-run is read-only.\n  ui [--port N] [--open=true|false]      Start the local read-only web UI (experimental) and open it in the browser.\n                                          Requires the ui/ subproject deps (npm install in ui/ once).\n\nMutating (require --as <agent-id>):\n  batch --file <json> --as <agent>       Execute an atomic batch from a JSON file.\n  batch --stdin --as <agent>             Execute an atomic batch from stdin.\n  take <id> --as <agent>                 Claim a ready task (idempotent when you already hold the claim).\n  submit <id> --note \"...\" --as <agent>  Submit an owned in-progress task for validation.\n  accept <id> --as <agent>               Accept a submitted task as done.\n  reject <id> --reason \"...\" --as <agent> Return a submitted task to open with a reason.\n                                          A policy plugin may authorise taking over another actor's claim.\n  release <id> --as <agent>              Free a claim (idempotent when the task is unclaimed). A policy\n                                          plugin may authorise releasing any claim.\n  cancel <id> --reason \"<text>\" --as <agent>\n                                          Terminate a node without resolving (open/in_progress only).\n  resolve <id> --choice \"<text>\" --rationale \"<text>\" --as <agent>\n                                          Resolve a choice gate; tasks close only through submit then accept.\n  reopen <id> --reason \"<text>\" --as <agent>\n                                          Re-open a done task or resolved gate; downstream tasks re-block.\n  restore <snapshot-id> --as <agent>      Replace the live state with the snapshot's raw bytes (validates target\n                                          v2/shape first; takes a pre-restore raw snapshot before changing state).\n                                          A policy plugin may deny or further restrict this action.\n  push --as <agent> [--overwrite=true]    Copy the local DAG to the configured remote project.\n                                          Overwrite is absolute; a timeout may leave the outcome unknown. No retry.\n  pull --as <agent> [--overwrite=true]    Copy the configured remote DAG into the local project.\n                                          Overwrite is absolute; the remote source is fetched before local writes.\n  deprecate-knowledge <id> --reason \"...\" --as <agent>\n                                          Soft-delete a knowledge node (sets status=deprecated + reason).\n\nAdding to the DAG:\n  add-task [id] --initiative X --title \"...\" --body \"...\" --acceptance \"...\" --blocked-by \"...\"\n                                          Append a task. Id is auto-allocated as T-xxxxxxxx when omitted.\n  add-gate [id] --initiative X --title \"...\" --body \"...\" --purpose decision|approval|external-dependency|research [--supersedes OLD]\n                                          Append a gate.\n  add-knowledge [id] --initiative X --title \"...\" --body \"...\" --scope-domains X [--supersedes OLD]\n                                          Append a knowledge node.\n  add-initiative <name> [--desc \"...\"]   Register an initiative.\n  add-node <id> --kind resolvable|knowledge --title \"...\" [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']\n                                          Low-level node creation (prefer add-task/add-gate/add-knowledge).\n  add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM\n                                          Low-level edge creation.\n  remove-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM\n                                          Idempotently remove one exact edge.\n\nEditing (any agent; status guard applies):\n  update <id> [--title X] [--body \"...\"] [--initiative X] [--domain Y] [--tags ...]\n              [--backlog true|false] [--if-revision N] --as <agent>\n                                          Edit a node's fields; increments revision.\n  add-note <id> \"text\" --as <agent>      Append a note to a node's running thread (any status).\n\nSetup:\n  init [--force]                          Create .climier.json and the project's live state.\n\nGlobal flags:\n  --project <dir>                         Project root (default: CWD)\n  --help, -h                              Show this help and exit\n  --version                               Show the package version and exit\n\nDocs: see README.md for quickstart, workflow, storage model, and command reference.\n\nAvailable commands:\n  status, context, take, submit, accept, reject, resolve, release, cancel, reopen, search, history,\n  show, update, add-note, add-initiative, add-task, add-gate, add-knowledge,\n  deprecate-knowledge, add-node, add-edge, remove-edge, initiatives, log, init, snapshots, state,\n  restore, batch, push, pull, migrate, ui, help, version.";

// Boolean flags do not consume the next non-flag token as their value. Specify
// them as `--flag=true` or after the command.
export const BOOLEAN_FLAGS = Object.freeze(new Set(["all", "force", "stdin", "dry-run"]));

function parsedFlag(argv, index) {
  const token = argv[index];
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1) {
    return { key: token.slice(2, equalsIndex), value: token.slice(equalsIndex + 1), nextIndex: index };
  }
  const key = token.slice(2);
  const next = argv[index + 1];
  const consumesNext = !BOOLEAN_FLAGS.has(key) && next !== undefined && !String(next).startsWith("--");
  return { key, value: consumesNext ? next : true, nextIndex: consumesNext ? index + 1 : index };
}

/** Parse the CLI argv while preserving the original token sequence. */
export function parseArgv(argv = []) {
  const originalArgv = Array.isArray(argv) ? argv.slice() : [];
  const flags = {};
  const positional = [];
  let command = null;
  let parsingCommand = false;

  for (let i = 0; i < originalArgv.length; i++) {
    const token = originalArgv[i];
    if (typeof token !== "string") {
      continue;
    }
    if (token.startsWith("--")) {
      const parsed = parsedFlag(originalArgv, i);
      flags[parsed.key] = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (!parsingCommand) {
      command = token;
      parsingCommand = true;
      continue;
    }
    positional.push(token);
  }

  return { originalArgv, command, flags, positional };
}

export function formatOutput(value) {
  return JSON.stringify(value, null, 2);
}

export function formatError(error) {
  return formatOutput({ ok: false, error });
}

export const KNOWN_COMMANDS = Object.freeze([
  "status", "context", "take", "submit", "accept", "reject", "resolve", "release", "cancel", "reopen",
  "search", "history", "show", "update", "add-note", "add-initiative", "add-task", "add-gate", "add-knowledge",
  "deprecate-knowledge", "add-node", "add-edge", "remove-edge", "initiatives", "log", "init", "snapshots", "state",
  "restore", "batch", "push", "pull", "migrate", "ui", "help", "version",
]);

const REMOTE_SUPPORTED_COMMANDS = new Set([
  "status", "context", "show", "history", "search", "initiatives", "log", "state",
  "take", "submit", "accept", "reject", "resolve", "release", "cancel", "reopen",
  "update", "add-note", "add-initiative", "add-task", "add-gate", "add-knowledge",
  "deprecate-knowledge", "add-node", "add-edge", "remove-edge", "batch", "init", "push", "pull",
]);

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
  if ((command === "push" || command === "pull") && typeof projectConfig.project_id !== "string") {
    requireRemoteProjectId(`dispatch: remote ${command} requires project_id`);
  }
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

function readProjectConfig(projectDir) {
  const file = projectMetaFile(projectDir);
  if (!fsSync.existsSync(file)) {
    return {};
  }
  let config;
  try {
    config = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (cause) {
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
  const allowed = new Set([...knownFlags, "project"]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      const sorted = [...allowed].filter((name) => name !== "project").toSorted();
      const error = new Error(`${command}: unknown flag --${key} (valid flags: --${sorted.join(", --")})`);
      error.code = "CLI_USAGE_ERROR";
      error.details = { command, flag: key, valid_flags: sorted };
      throw error;
    }
  }
}

/** Dispatch a parsed command and return its result without printing it. */
async function dispatchInstalledPlugin({
  command,
  originalArgv,
  flags,
  projectDir,
  backendClient,
  dispatchPluginInjected,
  hasInstalledPluginInjected,
}) {
  if (command === null || RESERVED_NAMESPACES.includes(command)) {
    return undefined;
  }
  const hasInstalledPlugin = hasInstalledPluginInjected
    || (await import("../plugins/loader.mjs")).hasInstalledPlugin;
  const dispatchPlugin = dispatchPluginInjected
    || (await import("../plugins/dispatch.mjs")).dispatchPlugin;
  if (!(await hasInstalledPlugin(command))) {
    return undefined;
  }
  return dispatchPlugin({ originalArgv, namespace: command, projectDir, flags, backendClient });
}

async function dispatchBuiltInCommand({
  command,
  flags,
  positional,
  statePath,
  projectDir,
  projectConfig,
  backendClient,
  source,
}) {
  const mod = await import(`./commands/${command}.mjs`);
  validateKnownFlags(command, flags, mod.knownFlags);
  return mod.default({ positional, flags, statePath, projectDir, projectConfig, backendClient, source });
}

export async function dispatchCommand(options = {}) {
  const {
    command,
    originalArgv = [],
    flags = {},
    positional = [],
    projectDir,
    statePath = projectDir,
    projectConfig = {},
    backendClient,
    source,
    dispatchPlugin: dispatchPluginInjected,
    hasInstalledPlugin: hasInstalledPluginInjected,
  } = options;
  ensureRemoteCommandSupported({ command, flags, projectConfig, backendClient });
  const pluginResult = await dispatchInstalledPlugin({
    command,
    originalArgv,
    flags,
    projectDir,
    backendClient,
    dispatchPluginInjected,
    hasInstalledPluginInjected,
  });
  if (pluginResult !== undefined) {
    return pluginResult;
  }
  return dispatchBuiltInCommand({
    command,
    flags,
    positional,
    statePath,
    projectDir,
    projectConfig,
    backendClient,
    source,
  });
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

function writeEarlyResponse(args, write, exit) {
  const hasHelpFlag = args.includes("--help") || args.includes("-h");
  const hasVersionFlag = args.includes("--version");
  if (hasHelpFlag) {
    return writeHelpResponse(write, exit);
  }
  if (hasVersionFlag) {
    return writeVersionResponse(write, exit);
  }
  return null;
}

function writeBuiltInResponse(command, write, exit) {
  if (command === "help") {
    return writeHelpResponse(write, exit);
  }
  if (command === "version") {
    return writeVersionResponse(write, exit);
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

async function addBackendContext(context, { source, backendClientFactory }) {
  const projectConfig = readProjectConfig(context.projectDir);
  const backendClient = backendClientFactory({ projectDir: context.projectDir, projectConfig, source });
  let selectedSource = source;
  if (backendClient?.type === "local") {
    selectedSource ??= await backendClient.operationSource;
  }
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

    await addBackendContext(context, { source, backendClientFactory });
    const result = await dispatchCommandFn(context);
    if (result !== undefined) {
      write(formatOutput(result));
    }
    return 0;
  } catch (error) {
    return writeCliError(error, parsed.command, write, exit);
  }
}

function cliOptions(options = {}) {
  return {
    argv: options.argv ?? process.argv.slice(2),
    write: options.write ?? console.log,
    exit: options.exit ?? process.exit,
    source: options.source,
    backendClientFactory: options.createBackendClient ?? createBackendClient,
    dispatchCommandFn: options.dispatch ?? dispatchCommand,
  };
}

async function runCliWithOptions(options = {}) {
  const { argv, write, exit, source, backendClientFactory, dispatchCommandFn } = cliOptions(options);
  const args = Array.isArray(argv) ? argv.slice() : [];
  const earlyResponse = writeEarlyResponse(args, write, exit);
  if (earlyResponse !== null) {
    return earlyResponse;
  }

  const parsed = parseArgv(args);
  const projectDir = resolveProject({ project: parsed.flags.project });
  const context = { ...parsed, projectDir, statePath: projectDir };
  return executeParsedCli({ parsed, context, source, backendClientFactory, dispatchCommandFn, write, exit });
}

export const runCli = runCliWithOptions;
