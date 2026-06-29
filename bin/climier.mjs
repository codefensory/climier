#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
// All command output is JSON to stdout. All errors are JSON to stdout with non-zero exit.
import path from "node:path";
import { resolveProject } from "../src/paths.mjs";

const args = process.argv.slice(2);

const HELP_TEXT = `climier — task DAG harness for multi-agent workflows

Usage: climier [--project <dir>] <command> [args...]

Output: every command prints a single JSON object to stdout.
Errors: { ok: false, error: "<message>" } on stdout, non-zero exit.

Read-only:
  status [--initiative X] [--staleMs N]   Global view: counts, in_progress, ready, blocked, stale, gotchas
  ready [--initiative X]                  Tasks claimable right now (the delegation view)
  next <id>                               Definition + acceptance + gotchas for a task
  pre-claim <id> [--staleMs N]            Pre-flight: spec, gotchas, derived status, GO/NO-GO verdict
  tasks [--initiative X] [--status Y]     List tasks, filterable
  graph [--initiative X]                  Print the DAG as text
  gotchas [--initiative X] [--domain Y]   List gotchas
  decisions [--initiative X]              List decisions
  log [--limit N] [--action X] [--agent X] [--task X]   Show the audit log
  show <id>                               Print the raw task, decision, or gotcha object

Mutating (require --as <agent-id>):
  claim <id>                              Atomically reserve a ready task
  done <id> "<note>"                      Mark complete, recompute ready
  release <id>                            Free a claim. --as orchestrator|recovery releases any agent's claim
  block <id> "<reason>"                   Mark a blocker on your claimed task (only the claim owner)
  reopen <id> --as <agent>                Re-open a done or skipped task
  decide <D> "<choice>" [--because "..."]  Close a decision, unblock dependents (--as defaults to orchestrator)

Adding to the DAG:
  add-task <id> --initiative X --title "..." [--depends-on A,B] [--skills ...] [--effort ...] [--domain ...] [--definition ...] [--acceptance ...]
  add-initiative <name> [--desc "..."]
  add-gotcha <id> --title "..." --applies-to domain:X[,T1,...] [--mitigation "..."]
  add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...] [--description "..."]

Setup:
  init [--seed NAME] [--force]            Create .agents/tasks/tasks.json (use --seed migration for the new-vegsport preset)

Global flags:
  --project <dir>                         Project root (default: CWD)
  --help, -h                              Show this help and exit

Docs: see .agents/skills/climier/SKILL.md in your project for the full guide.`;

// --help: handled before arg parsing so it works with or without --project.
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP_TEXT);
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
const statePath = path.join(projectDir, ".agents", "tasks", "tasks.json");

const ctx = { positional, flags, statePath, projectDir };

// Emit a JSON error to stdout and exit with the given code.
function failJson(error, code) {
  console.log(JSON.stringify({ ok: false, error }, null, 2));
  process.exit(code);
}

try {
  // Handle the `help` command (alias for --help) before importing, since there's no help.mjs.
  if (command === "help") {
    console.log(HELP_TEXT);
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
    if (!command) failJson("no command given. Available: status, ready, claim, next, pre-claim, done, release, reopen, block, decide, tasks, graph, gotchas, decisions, log, show, add-task, add-initiative, add-gotcha, add-decision, init", 2);
    failJson(`unknown command '${command}'`, 2);
  }
  failJson(err.message, 1);
}
