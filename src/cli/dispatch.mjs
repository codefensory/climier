// CLI entry and dispatch adapter.
//
// This module owns argv parsing, command/plugin routing, output formatting,
// and process-level error handling. `bin/climier.mjs` intentionally remains a
// thin executable wrapper around runCli().
import fsSync from "node:fs";

import { resolveProject } from "../storage/paths.mjs";
import { RESERVED_NAMESPACES } from "./commands/reserved-namespaces.mjs";

export const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export const HELP_TEXT = `climier — JSON-first task DAG CLI for coordinating work

Use it when one or many actors need a shared source of truth for what is
ready, claimed, blocked, decided, backlog, done, or archived.

Common patterns:
  solo / multi-session: status -> context -> take -> work -> submit -> accept
  human + AI:           add-task -> context -> take -> add-note -> submit -> accept
  with a policy plugin: see docs/PLUGINS.md (ADR-007/008); the core
                        no longer recognises actor names like
                        "orchestrator"/"recovery" as authority.

Usage: climier [--project <dir>] <command> [args...]

Output: every command prints a single JSON value to stdout.
Errors: { ok: false, error: "<message>" } on stdout, non-zero exit.
Exceptions: --help/-h/help and --version/version print plain text.

Read-only:
  status [--initiative X] [--kind task|gate|knowledge] [--status X] [--domain X]
        [--claimed-by X] [--stale-ms N] [--limit N] [--all]
                                          Summary-shape: task buckets (ready/in_progress/blocked/backlog), open gates, knowledge count, alerts.
                                          in_progress is global by default: every in_progress task is listed and counted
                                          regardless of caller. Use --claimed-by <agent> to narrow to one agent's claims.
                                          --as is an identity tag (it scopes context's allowed_actions) and is not a filter
                                          for status.
  context <id>                           Agent-first view of a node: spec, blockers, informing edges, scoped knowledge, allowed actions.
  search "<query>" [--all]               Search active knowledge; --all includes deprecated knowledge.
  initiatives                            List registered initiatives with usage counts.
  log [--limit N] [--action X] [--agent X] [--task X] [--decision X]
                                          Show the audit log.
  history <id> [--limit N]               Log entries that reference a node.
  show <id>                              Print the raw node object.
  snapshots                              List recoverable snapshots captured under <state-dir>/snapshots/, newest first.
  state                                  Read the deterministic current core projection (not historical snapshots).
  ui [--port N] [--open=true|false]      Start the local read-only web UI and open it in the browser.
                                          Requires the ui/ subproject deps (npm install in ui/ once).

Mutating (require --as <agent-id>):
  batch --file <json> --as <agent>       Execute an atomic batch from a JSON file.
  batch --stdin --as <agent>             Execute an atomic batch from stdin.
  take <id> --as <agent>                 Claim a ready task (idempotent when you already hold the claim).
  submit <id> --note "..." --as <agent>  Submit an owned in-progress task for validation.
  accept <id> --as <agent>               Accept a submitted task as done.
  reject <id> --reason "..." --as <agent> Return a submitted task to open with a reason.
                                          A policy plugin may authorise taking over another actor's claim.
  release <id> --as <agent>              Free a claim (idempotent when the task is unclaimed). A policy
                                          plugin may authorise releasing any claim.
  cancel <id> --reason "<text>" --as <agent>
                                          Terminate a node without resolving (open/in_progress only).
  resolve <id> --choice "<text>" --rationale "<text>" --as <agent>
                                          Resolve a choice gate; tasks close only through submit then accept.
  reopen <id> --reason "<text>" --as <agent>
                                          Re-open a done task or resolved gate; downstream tasks re-block.
  restore <snapshot-id> --as <agent>      Replace the live state with the snapshot's raw bytes (validates target
                                          v2/shape first; takes a pre-restore raw snapshot before changing state).
                                          A policy plugin may deny or further restrict this action.
  deprecate-knowledge <id> --reason "..." --as <agent>
                                          Soft-delete a knowledge node (sets status=deprecated + reason).

Adding to the DAG:
  add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by "..."
                                          Append a task. Id is auto-allocated as T-xxxxxxxx when omitted.
  add-gate [id] --initiative X --title "..." --body "..." --purpose decision|approval|external-dependency|research [--supersedes OLD]
                                          Append a gate.
  add-knowledge [id] --initiative X --title "..." --body "..." --scope-domains X [--supersedes OLD]
                                          Append a knowledge node.
  add-initiative <name> [--desc "..."]   Register an initiative.
  add-node <id> --kind resolvable|knowledge --title "..." [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']
                                          Low-level node creation (prefer add-task/add-gate/add-knowledge).
  add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM
                                          Low-level edge creation.
  remove-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM
                                          Idempotently remove one exact edge.

Editing (any agent; status guard applies):
  update <id> [--title X] [--body "..."] [--initiative X] [--domain Y] [--tags ...]
              [--backlog true|false] [--if-revision N] --as <agent>
                                          Edit a node's fields; increments revision.
  add-note <id> "text" --as <agent>      Append a note to a node's running thread (any status).

Setup:
  init [--force]                          Create .climier.json and the project's live state.

Global flags:
  --project <dir>                         Project root (default: CWD)
  --help, -h                              Show this help and exit
  --version                               Show the package version and exit

Docs: see README.md for quickstart, workflow, storage model, and command reference.

Available commands:
  status, context, take, submit, accept, reject, resolve, release, cancel, reopen, search, history,
  show, update, add-note, add-initiative, add-task, add-gate, add-knowledge,
  deprecate-knowledge, add-node, add-edge, remove-edge, initiatives, log, init, snapshots, state,
  restore, batch, ui, help, version.`;

// These flags must not consume the next non-flag token as their value. This
// preserves the historical `--force init` parsing behavior.
export const BOOLEAN_FLAGS = Object.freeze(new Set(["all", "force", "stdin"]));

/** Parse the CLI argv while preserving the original token sequence. */
export function parseArgv(argv = []) {
  const originalArgv = Array.isArray(argv) ? argv.slice() : [];
  const flags = {};
  const positional = [];
  let command = null;
  let parsingCommand = false;

  for (let i = 0; i < originalArgv.length; i++) {
    const token = originalArgv[i];
    if (typeof token !== "string") continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      let key;
      let value;
      if (eq !== -1) {
        key = token.slice(2, eq);
        value = token.slice(eq + 1);
      } else {
        key = token.slice(2);
        const next = originalArgv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !String(next).startsWith("--")) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      flags[key] = value;
      continue;
    }
    if (!parsingCommand) {
      command = token;
      parsingCommand = true;
    } else {
      positional.push(token);
    }
  }

  return { originalArgv, command, flags, positional };
}

export function formatOutput(value) {
  return JSON.stringify(value, null, 2);
}

export function formatError(error) {
  return formatOutput({ ok: false, error });
}

// Stable descriptive aliases for consumers of the CLI adapter boundary.
export const parseArgs = parseArgv;

function validateKnownFlags(command, flags, knownFlags) {
  if (!Array.isArray(knownFlags)) return;
  const allowed = new Set([...knownFlags, "project"]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      const sorted = [...allowed].filter((name) => name !== "project").sort();
      throw new Error(`${command}: unknown flag --${key} (valid flags: --${sorted.join(", --")})`);
    }
  }
}

/** Dispatch a parsed command and return its result without printing it. */
export async function dispatchCommand({
  command,
  originalArgv = [],
  flags = {},
  positional = [],
  projectDir,
  statePath = projectDir,
} = {}) {
  if (command !== null && !RESERVED_NAMESPACES.includes(command)) {
    const { hasInstalledPlugin } = await import("../plugins/loader.mjs");
    const { dispatchPlugin } = await import("../plugins/dispatch.mjs");
    if (await hasInstalledPlugin(command)) {
      return dispatchPlugin({ originalArgv, namespace: command, projectDir, flags });
    }
  }

  const mod = await import(`./commands/${command}.mjs`);
  validateKnownFlags(command, flags, mod.knownFlags);
  return mod.default({ positional, flags, statePath, projectDir });
}

function exitWith(exit, code) {
  exit(code);
}

export const dispatch = dispatchCommand;

/** Run the complete CLI. The injectable writer/exit make this testable. */
export async function runCli({ argv = process.argv.slice(2), write = console.log, exit = process.exit } = {}) {
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.includes("--help") || args.includes("-h")) {
    write(HELP_TEXT);
    exitWith(exit, 0);
    return 0;
  }
  if (args.includes("--version")) {
    write(PACKAGE_VERSION);
    exitWith(exit, 0);
    return 0;
  }

  const parsed = parseArgv(args);
  const projectDir = resolveProject({ project: parsed.flags.project });
  const context = { ...parsed, projectDir, statePath: projectDir };

  try {
    if (parsed.command === "help") {
      write(HELP_TEXT);
      exitWith(exit, 0);
      return 0;
    }
    if (parsed.command === "version") {
      write(PACKAGE_VERSION);
      exitWith(exit, 0);
      return 0;
    }

    const result = await dispatchCommand(context);
    if (result !== undefined) write(formatOutput(result));
    return 0;
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") {
      if (!parsed.command) {
        write(formatError(
          "no command given. Available: status, context, take, submit, accept, reject, resolve, release, cancel, reopen, search, history, show, update, add-note, add-task, add-gate, add-knowledge, add-initiative, add-node, add-edge, remove-edge, deprecate-knowledge, initiatives, log, init, snapshots, state, restore, batch, ui, help, version",
        ));
      } else {
        write(formatError(`unknown command '${parsed.command}'`));
      }
      exitWith(exit, 2);
      return 2;
    }
    if (error.code && error.details !== undefined) {
      write(formatError({ code: error.code, message: error.message, details: error.details }));
    } else {
      write(formatError(error.message));
    }
    exitWith(exit, 1);
    return 1;
  }
}

export const main = runCli;
