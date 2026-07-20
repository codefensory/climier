#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
// All command output is JSON to stdout. All errors are JSON to stdout with non-zero exit.
import fsSync from "node:fs";
import { resolveProject } from "../src/paths.mjs";

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
  orchestrator/workers: status -> context -> take -> add-note / block-on-knowledge / resolve / reopen

Usage: climier [--project <dir>] <command> [args...]

Output: every command prints a single JSON value to stdout.
Errors: { ok: false, error: "<message>" } on stdout, non-zero exit.
Exceptions: --help/-h/help and --version/version print plain text.

Read-only:
  status [--initiative X] [--staleMs N]   Summary-shape: task buckets (ready/in_progress/blocked/backlog/done), open gates, knowledge count, alerts (v2). v1: legacy full view.
  ready [--initiative X]                  (v1) Tasks claimable right now
  next <id>                               Definition + acceptance + gotchas for a task
  pre-claim <id> [--staleMs N]            Task detail + pre-flight: spec, gotchas, derived status, structured dep details, GO/NO-GO verdict
  context <id>                            v2 agent-first context view: node, blockers, informing edges, scoped knowledge
  search "<query>" [--all]                Search active v2 knowledge; --all includes deprecated knowledge
  tasks [--initiative X] [--status Y]     List tasks, filterable
  graph [--initiative X]                  Print the DAG as text
  initiatives                             List registered initiatives with usage counts; surfaces orphan (unregistered) initiative references
  next-id <phase> [--suffix R]            Get the next free task id for a phase (e.g. F1 -> F1.T3; --suffix R -> F1.T1R)
  gotchas [--initiative X] [--domain Y]   List gotchas
  decisions [--initiative X]              List decisions
  log [--limit N] [--action X] [--agent X] [--task X] [--decision X]
                                           Show the audit log
  history <id> [--limit N]                Log entries that reference a node (v2) or task (v1)
  show <id>                               Print the raw node object

Mutating (require --as <agent-id>):
  take <id> --as <agent>                  (v2) Idempotently claim the explicit ready task; orchestrator may take over another claim
  claim <id>                              Atomically reserve a ready task
  done <id> "<note>"                      Mark complete, recompute ready
  release <id>                            Free a claim. --as orchestrator|recovery releases any agent's claim
  cancel <id> "<reason>" --as <agent>     (v2) Terminate a node without resolving (open/in_progress only)
  resolve <id> --note "<text>" --as <agent>  (v2) Close a task as done; --choice/--rationale close a gate
  block <id> "<reason>"                   Mark a blocker on your claimed task (only the claim owner)
  reopen <id> "<reason>" --as <agent>     Re-open a done task; downstream tasks re-block
  archive <id> "<reason>" --as <agent>   Mark a task archived (terminal). in_progress requires claimer (or orchestrator|recovery).
  decide <D> "<choice>" [--because "..."]  Close a decision, unblock dependents (--as defaults to orchestrator)
  promote <id> --as <agent>               Move a backlog task into the ready pool (removes the backlog flag)

Adding to the DAG:
  add-task <id> --initiative X --title "..." [--depends-on A,B] [--skills ...] [--effort ...] [--domain ...]
           [--definition ...] [--acceptance ...] [--backlog true] [--priority high|medium|low]
  add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by "..."  (v2)
  add-gate [id] --initiative X --title "..." --body "..." --purpose decision|approval|external-dependency|research [--supersedes OLD]
  add-knowledge [id] --initiative X --title "..." --body "..." --scope-domains X [--supersedes OLD]
  add-task --phase F1 --initiative X --title "..." [--suffix R] [...same options...]
  add-initiative <name> [--desc "..."]
  add-gotcha <id> --title "..." --applies-to domain:X[,T1,...] [--mitigation "..."]
  add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...] [--description "..."]
  add-node <id> --kind resolvable|knowledge --title "..." [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']
  add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM
                                           (low-level; prefer add-task/add-gate/add-knowledge)

Editing tasks (any agent; status guard applies):
  update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--skills a,b]
              [--effort S|M|L] [--domain Y] [--depends-on A,B] [--backlog true|false]
              [--priority high|medium|low] [--if-revision N] --as <agent>
                                           Edit a task. in_progress/done are locked. --depends-on rewrites the dependency list. --if-revision is v2 optimistic-concurrency.
  add-note <id> "text" --as <agent>       Append a note to a task or v2 node's running thread (any status)

Lifecycle (soft delete):
  close-gotcha <id> --as <agent>          Mark a gotcha resolved (normal views hide it)
  deprecate-knowledge <id> --reason "..." --as <agent>
                                           Soft-delete a v2 knowledge node (sets status=deprecated + reason)
  reopen-gotcha <id> --as <agent>         Undo a close-gotcha

Setup:
  init [--force] [--v2]                   Create .climier.json and the project's live state (--v2 creates the experimental nodes/edges schema)

Global flags:
  --project <dir>                         Project root (default: CWD)
  --help, -h                              Show this help and exit
  --version                               Show the package version and exit

Docs: see README.md for quickstart, workflow, storage model, and command reference.

Available commands (v2 surface, plus v1-legacy commands that work on v1 states):
  v2: status, context, take, resolve, release, cancel, reopen, search, history,
      show, update, add-note, add-initiative, add-task, add-gate, add-knowledge,
      deprecate-knowledge, add-node, add-edge, initiatives, log, init, help, version
  v1: ready, claim, done, block, archive, promote, decide, next, pre-claim,
      tasks, graph, gotchas, decisions, next-id, add-decision, add-gotcha,
      close-gotcha, reopen-gotcha`;

// --help / --version: handled before arg parsing so they work with or without --project.
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP_TEXT);
  process.exit(0);
}
if (args.includes("--version")) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}

let command = null;
const flags = {};
const positional = [];
let parsingCommand = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  // Boolean flags that must NOT consume the next non-flag arg as their value.
  // Without this, `climier --force init` would parse as --force=init.
  // `json` is kept here so the parser treats it as boolean; the command's
  // knownFlags check then rejects it (it's no longer a global flag).
  const BOOLEAN_FLAGS = new Set(["all", "force", "json", "v2"]);

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
  // F6 / F11 / F12: some commands swap their backing module when the project
  // is v2. Resolve the target module BEFORE the default import so that v2-only
  // commands (deprecate-knowledge, whose v2 module is named
  // v2-deprecate-knowledge.mjs) don't blow up on a synchronous ENOENT.
  // ponytail: the lifecycle commands all use the v2-${command}.mjs naming,
  // so the dispatch chain below is just the exceptions (update, status,
  // deprecate-knowledge) plus a `v2-${command}` fallback for everything else.
  let v2Swap = false;
  if (
    command === "update"
    || command === "status"
    || command === "deprecate-knowledge"
    || command === "release"
    || command === "resolve"
    || command === "reopen"
    || command === "cancel"
  ) {
    const { isV2State, readState } = await import("../src/state.mjs");
    const s = await readState(projectDir);
    if (s && isV2State(s)) v2Swap = true;
  }
  let mod;
  if (v2Swap) {
    if (command === "update") mod = await import("../src/commands/v2-update.mjs");
    else if (command === "status") mod = await import("../src/commands/v2-status.mjs");
    else if (command === "deprecate-knowledge") mod = await import("../src/commands/v2-deprecate-knowledge.mjs");
    else mod = await import(`../src/commands/v2-${command}.mjs`);
  } else {
    mod = await import(`../src/commands/${command}.mjs`);
  }
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
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
    if (!command) failJson("no command given. Available: status, ready, take, claim, next, pre-claim, context, search, done, release, reopen, cancel, resolve, archive, block, decide, promote, tasks, graph, next-id, gotchas, decisions, log, history, show, update, add-note, add-task, add-gate, add-knowledge, add-initiative, add-gotcha, add-decision, add-node, add-edge, close-gotcha, deprecate-knowledge, reopen-gotcha, initiatives, init, help, version", 2);
    failJson(`unknown command '${command}'`, 2);
  }
  // F2: v2 commands throw with .code + .details via errors.mjs. Emit the
  // rich shape. v1 commands still throw plain Error; their err.message is
  // the contract.
  if (err.code && err.details !== undefined) {
    failJson({ code: err.code, message: err.message, details: err.details }, 1);
  }
  failJson(err.message, 1);
}
