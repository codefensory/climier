#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
import path from "node:path";
import { resolveProject } from "../src/paths.mjs";
import { formatStatus, formatReady, formatNext, formatTasks, formatGraph, formatTaskShort, formatGotchas, formatDecisions, formatLog, formatShow, formatPreClaim } from "../src/views.mjs";

const args = process.argv.slice(2);

const HELP_TEXT = `climier — task DAG harness for multi-agent workflows

Usage: climier [--project <dir>] [--json] <command> [args...]

Read-only (no --as needed):
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
  --json                                  Output as JSON instead of formatted text
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
  // Boolean flags that should NOT consume the next non-flag arg as their value.
  // Without this list, `climier --json status` would parse as `--json=status`.
  const BOOLEAN_FLAGS = new Set(["json", "force", "force=true"]);

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

// Commands whose output is a list/object and benefit from a JSON mode.
const dataCommands = new Set([
  "status", "ready", "next", "tasks", "graph", "gotchas", "decisions", "log", "show", "pre-claim",
]);

const printers = {
  status: (r) => console.log(formatStatus(r)),
  ready: (r) => console.log(formatReady(r)),
  next: (r) => console.log(formatNext(r)),
  tasks: (r) => console.log(formatTasks(r)),
  graph: (r) => console.log(formatGraph(r)),
  gotchas: (r) => console.log(formatGotchas(r)),
  decisions: (r) => console.log(formatDecisions(r)),
  log: (r) => console.log(formatLog(r)),
  show: (r) => console.log(formatShow(r)),
  "pre-claim": (r) => console.log(formatPreClaim(r)),
  init: (r) => console.log(`✓ init: created ${r.file}${r.seeded ? " (seeded: " + r.seeded + ")" : ""}`),
  claim: (r) => console.log(`✓ claimed ${r.task.id}  → ${formatTaskShort(r.task)}`),
  done: (r) => console.log(`✓ done ${r.task.id}`),
  release: (r) => console.log(`✓ released ${r.task.id}`),
  reopen: (r) => console.log(`✓ reopened ${r.task.id}`),
  block: (r) => console.log(`✓ blocked ${r.task.id}: ${r.task.block_reason}`),
  decide: (r) => console.log(`✓ decision ${r.decision.id} → ${r.decision.choice}`),
  "add-task": (r) => console.log(`✓ added task ${r.task.id}`),
  "add-initiative": (r) => console.log(`✓ added initiative ${r.initiative.name}`),
  "add-gotcha": (r) => console.log(`✓ added gotcha ${r.gotcha.id}`),
  "add-decision": (r) => console.log(`✓ added decision ${r.decision.id}`),
};

const jsonPrinters = {
  show: (r) => r.node,
  "pre-claim": (r) => r,
  // status/ready/tasks/etc. return the raw object/array; for claim/done we
  // return the underlying entity so consumers can read fields directly.
  claim: (r) => ({ task: r.task }),
  done: (r) => ({ task: r.task }),
  release: (r) => ({ task: r.task }),
  reopen: (r) => ({ task: r.task }),
  block: (r) => ({ task: r.task }),
  decide: (r) => ({ decision: r.decision }),
  "add-task": (r) => ({ task: r.task }),
  "add-initiative": (r) => ({ initiative: r.initiative }),
  "add-gotcha": (r) => ({ gotcha: r.gotcha }),
  "add-decision": (r) => ({ decision: r.decision }),
  init: (r) => ({ ok: r.ok, seeded: r.seeded, file: r.file }),
};

try {
  // Handle the `help` command (alias for --help) before importing, since there's no help.mjs.
  if (command === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const mod = await import(`../src/commands/${command}.mjs`);
  // Reject unknown flags. Global flags (--project, --json) are always allowed.
  // --help / -h are handled before this point and never reach here.
  if (Array.isArray(mod.knownFlags)) {
    const allowed = new Set([...mod.knownFlags, "project", "json"]);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) {
        const sorted = [...allowed].filter((k) => k !== "project" && k !== "json").sort();
        throw new Error(`${command}: unknown flag --${key} (valid flags: --${sorted.join(", --")})`);
      }
    }
  }
  const result = await mod.default(ctx);
  if (result !== undefined) {
    if (flags.json) {
      const jp = jsonPrinters[command];
      const out = jp ? jp(result) : result;
      console.log(JSON.stringify(out, null, 2));
    } else {
      const print = printers[command];
      if (print) print(result);
      else console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
    if (!command) {
      console.error("climier: no command given. Available: status, ready, claim, next, pre-claim, done, release, reopen, block, decide, tasks, graph, gotchas, decisions, log, show, add-task, add-initiative, add-gotcha, add-decision, init");
      process.exit(2);
    }
    console.error(`climier: unknown command '${command}'`);
    process.exit(2);
  }
  console.error(`climier: ${err.message}`);
  process.exit(1);
}
