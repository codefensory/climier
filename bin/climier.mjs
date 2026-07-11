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
  solo / multi-session: status -> ready -> claim -> next -> work -> done
  human + AI:           add-task -> pre-claim -> claim -> add-note/block -> done
  orchestrator/workers: status -> ready -> delegate -> decide/release/reopen

Usage: climier [--project <dir>] <command> [args...]

Output: every command prints a single JSON value to stdout.
Errors: { ok: false, error: "<message>" } on stdout, non-zero exit.
Exceptions: --help/-h/help and --version/version print plain text.

Read-only:
  status [--initiative X] [--staleMs N]   Global view: summary, alerts, in_progress, ready, backlog, blocked, open decisions, stale claims, gotchas
  ready [--initiative X]                  Tasks claimable right now
  next <id>                               Definition + acceptance + gotchas for a task
  pre-claim <id> [--staleMs N]            Task detail + pre-flight: spec, gotchas, derived status, structured dep details, GO/NO-GO verdict
  tasks [--initiative X] [--status Y]     List tasks, filterable
  graph [--initiative X]                  Print the DAG as text
  initiatives                             List registered initiatives with usage counts; surfaces orphan (unregistered) initiative references
  next-id <phase> [--suffix R]            Get the next free task id for a phase (e.g. F1 -> F1.T3; --suffix R -> F1.T1R)
  gotchas [--initiative X] [--domain Y]   List gotchas
  decisions [--initiative X]              List decisions
  log [--limit N] [--action X] [--agent X] [--task X] [--decision X]
                                           Show the audit log
  show <id>                               Print the raw task, decision, or gotcha object

Mutating (require --as <agent-id>):
  claim <id>                              Atomically reserve a ready task
  done <id> "<note>"                      Mark complete, recompute ready
  release <id>                            Free a claim. --as orchestrator|recovery releases any agent's claim
  block <id> "<reason>"                   Mark a blocker on your claimed task (only the claim owner)
  reopen <id> "<reason>" --as <agent>     Re-open a done task; downstream tasks re-block
  archive <id> "<reason>" --as <agent>   Mark a task archived (terminal). in_progress requires claimer (or orchestrator|recovery).
  decide <D> "<choice>" [--because "..."]  Close a decision, unblock dependents (--as defaults to orchestrator)
  promote <id> --as <agent>               Move a backlog task into the ready pool (removes the backlog flag)

Adding to the DAG:
  add-task <id> --initiative X --title "..." [--depends-on A,B] [--skills ...] [--effort ...] [--domain ...]
           [--definition ...] [--acceptance ...] [--backlog true] [--priority high|medium|low]
  add-task --phase F1 --initiative X --title "..." [--suffix R] [...same options...]
  add-initiative <name> [--desc "..."]
  add-gotcha <id> --title "..." --applies-to domain:X[,T1,...] [--mitigation "..."]
  add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...] [--description "..."]

Editing tasks (any agent; status guard applies):
  update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--skills a,b]
              [--effort S|M|L] [--domain Y] [--depends-on A,B] [--backlog true|false]
              [--priority high|medium|low] --as <agent>
                                           Edit a task. in_progress/done are locked. --depends-on rewrites the dependency list.
  add-note <id> "text" --as <agent>       Append a note to a task's running thread (any status)

Lifecycle (soft delete):
  close-gotcha <id> --as <agent>          Mark a gotcha resolved (normal views hide it)
  reopen-gotcha <id> --as <agent>         Undo a close-gotcha

Setup:
  init [--seed NAME] [--force]            Create .climier.json and the project's live state (use --seed migration for the built-in example DAG)

Global flags:
  --project <dir>                         Project root (default: CWD)
  --help, -h                              Show this help and exit
  --version                               Show the package version and exit

Docs: see README.md for quickstart, workflow, storage model, and command reference.`;

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
  const BOOLEAN_FLAGS = new Set(["force", "json"]);

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
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
    if (!command) failJson("no command given. Available: status, ready, claim, next, pre-claim, done, release, reopen, archive, block, decide, promote, tasks, graph, next-id, gotchas, decisions, log, show, update, add-note, add-task, add-initiative, add-gotcha, add-decision, close-gotcha, reopen-gotcha, initiatives, init, help, version", 2);
    failJson(`unknown command '${command}'`, 2);
  }
  failJson(err.message, 1);
}
