#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
import path from "node:path";
import { resolveProject } from "../src/paths.mjs";
import { formatStatus, formatReady, formatNext, formatTasks, formatGraph, formatTaskShort, formatGotchas, formatDecisions, formatLog, formatShow } from "../src/views.mjs";

const args = process.argv.slice(2);

// Find command: first non-flag arg. Flags can appear before the command.
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
  "status", "ready", "next", "tasks", "graph", "gotchas", "decisions", "log", "show",
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
  init: (r) => console.log(`✓ init: created ${r.file}${r.seeded ? " (seeded: " + r.seeded + ")" : ""}`),
  claim: (r) => console.log(`✓ claimed ${r.task.id}  → ${formatTaskShort(r.task)}`),
  done: (r) => console.log(`✓ done ${r.task.id}`),
  release: (r) => console.log(`✓ released ${r.task.id}`),
  block: (r) => console.log(`✓ blocked ${r.task.id}: ${r.task.block_reason}`),
  decide: (r) => console.log(`✓ decision ${r.decision.id} → ${r.decision.choice}`),
  "add-task": (r) => console.log(`✓ added task ${r.task.id}`),
  "add-initiative": (r) => console.log(`✓ added initiative ${r.initiative.name}`),
  "add-gotcha": (r) => console.log(`✓ added gotcha ${r.gotcha.id}`),
};

const jsonPrinters = {
  show: (r) => r.node,
  // status/ready/tasks/etc. return the raw object/array; for claim/done we
  // return the underlying entity so consumers can read fields directly.
  claim: (r) => ({ task: r.task }),
  done: (r) => ({ task: r.task }),
  release: (r) => ({ task: r.task }),
  block: (r) => ({ task: r.task }),
  decide: (r) => ({ decision: r.decision }),
  "add-task": (r) => ({ task: r.task }),
  "add-initiative": (r) => ({ initiative: r.initiative }),
  "add-gotcha": (r) => ({ gotcha: r.gotcha }),
  init: (r) => ({ ok: r.ok, seeded: r.seeded, file: r.file }),
};

try {
  const mod = await import(`../src/commands/${command}.mjs`);
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
      console.error("climier: no command given. Available: status, ready, claim, next, done, release, block, decide, tasks, graph, gotchas, decisions, log, show, add-task, add-initiative, add-gotcha, init");
      process.exit(2);
    }
    console.error(`climier: unknown command '${command}'`);
    process.exit(2);
  }
  console.error(`climier: ${err.message}`);
  process.exit(1);
}
