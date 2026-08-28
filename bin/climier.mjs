#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
// All command output is JSON to stdout. All errors are JSON to stdout with non-zero exit.
//
// T-plugin-dispatch: after argv parsing, if the first non-flag token is
// not a reserved core command and an installed plugin exists at that
// namespace, route through src/plugin-dispatch.mjs. Plugin errors keep
// the same { ok: false, error: { code, message, details } } envelope as
// core v2 errors, so the existing catch can serialize them without
// changes.
import fsSync from "node:fs";
import { resolveProject } from "../src/paths.mjs";
import { RESERVED_NAMESPACES } from "../src/commands/reserved-namespaces.mjs";

const args = process.argv.slice(2);
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

const HELP_TEXT = `climier — JSON-first task DAG CLI for coordinating work

Use it when one or many actors need a shared source of truth for what is
ready, claimed, blocked, decided, backlog, done, or archived.

Common patterns:
  solo / multi-session: status -> context -> take -> work -> resolve
  human + AI:           add-task -> context -> take -> add-note -> resolve
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
  ui [--port N] [--open=true|false]      Start the local read-only web UI and open it in the browser.
                                          Requires the ui/ subproject deps (npm install in ui/ once).

Mutating (require --as <agent-id>):
  take <id> --as <agent>                 Claim a ready task (idempotent when you already hold the claim).
                                          A policy plugin may authorise taking over another actor's claim.
  release <id> --as <agent>              Free a claim (idempotent when the task is unclaimed). A policy
                                          plugin may authorise releasing any claim.
  cancel <id> --reason "<text>" --as <agent>
                                          Terminate a node without resolving (open/in_progress only).
  resolve <id> --note "<text>" --as <agent>
                                          Close a task as done; --choice/--rationale close a gate.
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
  status, context, take, resolve, release, cancel, reopen, search, history,
  show, update, add-note, add-initiative, add-task, add-gate, add-knowledge,
  deprecate-knowledge, add-node, add-edge, initiatives, log, init, snapshots,
  restore, ui, help, version.`;

// --help / --version: handled before arg parsing so they work with or without --project.
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP_TEXT);
  process.exit(0);
}
if (args.includes("--version")) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}

// Capture the original argv verbatim (before the parsing loop below).
// Plugin dispatch needs to forward tokens to the handler in their
// original order, including flags placed before the namespace — the
// parsing loop consumes flags into a `flags` object and does not
// preserve order on its own.
const originalArgv = args.slice();

let command = null;
const flags = {};
const positional = [];
let parsingCommand = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  // Boolean flags that must NOT consume the next non-flag arg as their value.
  // Without this, `climier --force init` would parse as --force=init.
  // `all` is kept here so the parser treats it as boolean; the command's
  // knownFlags check then validates it (only `search` opts in to --all).
  const BOOLEAN_FLAGS = new Set(["all", "force"]);

  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const isBool = BOOLEAN_FLAGS.has(key);
      const next = args[i + 1];
      if (!isBool && next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        val = true;
      }
    }
    flags[key] = val;
    continue;
  }
  if (!parsingCommand) {
    command = a;
    parsingCommand = true;
    continue;
  }
  positional.push(a);
}

const projectDir = resolveProject({ project: flags.project });
const statePath = projectDir;

const ctx = { positional, flags, statePath, projectDir };

// Emit a JSON error to stdout and exit with the given code.
function failJson(error, code) {
  console.log(JSON.stringify({ ok: false, error }, null, 2));
  process.exit(code);
}

try {
  // Handle the plain-text meta commands before importing, since there's no help.mjs/version.mjs.
  if (command === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (command === "version") {
    console.log(PACKAGE_VERSION);
    process.exit(0);
  }

  // T-plugin-dispatch: route to the plugin host when the first non-flag
  // token is neither a reserved core namespace nor a known core file.
  // Plugin dispatch throws PLUGIN_* errors on every failure path; the
  // existing catch below serializes them via the { code, message,
  // details } envelope (exit 1). If no plugin is installed for the
  // namespace, we fall through to the core dispatch, which fails with
  // MODULE_NOT_FOUND → `unknown command '<x>'` (exit 2).
  //
  // T-plugin-command-layout-fix / ADR-005: discovery scans
  // installed/*/package.json for descriptor.command === first-token
  // (no persistent registry). The loader raises PLUGIN_LOAD_FAILED if
  // a non-installed first token slips through.
  let pluginDispatched = false;
  if (command !== null && !RESERVED_NAMESPACES.includes(command)) {
    const { hasInstalledPlugin } = await import("../src/plugin-loader.mjs");
    const { dispatchPlugin } = await import("../src/plugin-dispatch.mjs");
    if (await hasInstalledPlugin(command)) {
      const pluginResult = await dispatchPlugin({
        originalArgv,
        namespace: command,
        projectDir,
        flags,
      });
      if (pluginResult !== undefined) {
        console.log(JSON.stringify(pluginResult, null, 2));
      }
      pluginDispatched = true;
    }
  }

  if (pluginDispatched) {
    // Skip the core dispatch entirely.
  } else {
    const mod = await import(`../src/commands/${command}.mjs`);
  // Reject unknown flags. Global flag (--project) is always allowed.
  // --help / -h are handled before this point and never reach here.
  if (Array.isArray(mod.knownFlags)) {
      const allowed = new Set([...mod.knownFlags, "project"]);
      for (const key of Object.keys(flags)) {
        if (!allowed.has(key)) {
          const sorted = [...allowed].filter((k) => k !== "project").sort();
          throw new Error(`${command}: unknown flag --${key} (valid flags: --${sorted.join(", --")})`);
        }
      }
    }
    const result = await mod.default(ctx);
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
    if (!command) {
      failJson(
        "no command given. Available: status, context, take, resolve, release, cancel, reopen, search, history, show, update, add-note, add-task, add-gate, add-knowledge, add-initiative, add-node, add-edge, deprecate-knowledge, initiatives, log, init, snapshots, restore, ui, help, version",
        2,
      );
    }
    failJson(`unknown command '${command}'`, 2);
  }
  // F2: v2 commands throw with .code + .details via errors.mjs. Emit the
  // rich shape. Their err.message remains the human-readable contract.
  if (err.code && err.details !== undefined) {
    failJson({ code: err.code, message: err.message, details: err.details }, 1);
  }
  failJson(err.message, 1);
}
