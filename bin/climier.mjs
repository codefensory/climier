#!/usr/bin/env node
// Climier CLI entry point. Parses argv, resolves project path, dispatches to commands.
import path from "node:path";
import { resolveProject } from "../src/paths.mjs";
import { formatStatus, formatReady, formatNext, formatTasks, formatGraph, formatTaskShort } from "../src/views.mjs";

const args = process.argv.slice(2);

// Find command: first non-flag arg. Flags can appear before the command.
let command = null;
const flags = {};
const positional = [];
let parsingCommand = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
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

const printers = {
  status: (r) => console.log(formatStatus(r)),
  ready: (r) => console.log(formatReady(r)),
  next: (r) => console.log(formatNext(r)),
  tasks: (r) => console.log(formatTasks(r)),
  graph: (r) => console.log(formatGraph(r)),
  init: (r) => console.log(`✓ init: created ${r.file}${r.seeded ? " (seeded: " + r.seeded + ")" : ""}`),
  claim: (r) => console.log(`✓ claimed ${r.task.id}  → ${formatTaskShort(r.task)}`),
  done: (r) => console.log(`✓ done ${r.task.id}`),
  release: (r) => console.log(`✓ released ${r.task.id}`),
  block: (r) => console.log(`✓ blocked ${r.task.id}: ${r.task.block_reason}`),
  decide: (r) => console.log(`✓ decision ${r.decision.id} → ${r.decision.choice}`),
  "add-task": (r) => console.log(`✓ added task ${r.task.id}`),
  "add-initiative": (r) => console.log(`✓ added initiative ${r.initiative.name}`),
};

try {
  const mod = await import(`../src/commands/${command}.mjs`);
  const result = await mod.default(ctx);
  if (result !== undefined) {
    const print = printers[command];
    if (print) print(result);
    else console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
    if (!command) {
      console.error("climier: no command given. Available: status, ready, claim, next, done, release, block, decide, tasks, graph, add-task, add-initiative, init");
      process.exit(2);
    }
    console.error(`climier: unknown command '${command}'`);
    process.exit(2);
  }
  console.error(`climier: ${err.message}`);
  process.exit(1);
}
