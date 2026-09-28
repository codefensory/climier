#!/usr/bin/env node
// Check the public v1 surface against the canonical CLI/provider declarations.
// This deliberately derives commands, flags, history references and update keys
// from source modules instead of maintaining a second list in documentation.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HELP_TEXT, KNOWN_COMMANDS } from "../src/cli/dispatch.mjs";
import { REFERENCE_FIELDS } from "../src/cli/commands/history.mjs";
import { ALLOWED_PATCH_KEYS as TASK_PATCH_KEYS } from "../src/providers/task/update.mjs";
import { ALLOWED_PATCH_KEYS as GATE_PATCH_KEYS } from "../src/providers/gate/update.mjs";
import { PATCHABLE_FIELDS as KNOWLEDGE_PATCH_KEYS } from "../src/providers/knowledge/update.mjs";
import { UPDATE_FLAG_TO_KEY } from "../src/cli/commands/update.mjs";

const GLOBAL_FLAGS = new Set(["project", "help", "h", "version"]);
const COMMAND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/commands");
const TARGETS = ["README.md", "docs/reference.md", "CLIMIER-CHEATSHEET.md", "AGENTS.md", ".github/workflows/ci.yml"];

async function canonicalFlags() {
  const result = new Map();
  for (const command of KNOWN_COMMANDS) {
    result.set(command, new Set());
  }
  const files = await fs.readdir(COMMAND_DIR);
  for (const file of files.filter((name) => name.endsWith(".mjs"))) {
    const command = file.slice(0, -4);
    if (!KNOWN_COMMANDS.includes(command)) continue;
    const module = await import(pathToFileURL(path.join(COMMAND_DIR, file)).href);
    if (Array.isArray(module.knownFlags)) {
      result.set(command, new Set(module.knownFlags));
    }
  }
  return result;
}

function issue(issues, file, line, message) {
  issues.push(`${file}:${line}: ${message}`);
}

function commandFromLine(line, currentCommand, commands) {
  const heading = line.match(/^###\s+`([a-z][a-z0-9-]*)\b/i);
  if (heading && commands.has(heading[1])) return heading[1];
  const table = line.match(/^\|\s*`([a-z][a-z0-9-]*)\b/i);
  if (table && commands.has(table[1])) return table[1];
  const invocation = line.match(/\bclimier\s+(?:--project\s+\S+\s+)?([a-z][a-z0-9-]*)\b/i);
  if (invocation && commands.has(invocation[1])) return invocation[1];
  return currentCommand;
}

function scanText(text, file, { flagsByCommand, commands, issues, help = false, persistent = false }) {
  let currentCommand = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (help) {
      const candidate = line.match(/^\s{2}([a-z][a-z0-9-]*)\b/);
      currentCommand = candidate && commands.has(candidate[1]) ? candidate[1] : null;
    } else {
      currentCommand = commandFromLine(line, persistent ? currentCommand : null, commands);
      if (persistent && /^#{1,2}\s+/.test(line) && !line.startsWith("### `")) currentCommand = null;
    }

    if (currentCommand) {
      const allowed = new Set([...GLOBAL_FLAGS, ...(flagsByCommand.get(currentCommand) ?? [])]);
      const codeSpans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const tableOrHeading = /^\s*\|/.test(line) || /^###\s+`/.test(line);
      const declarations = tableOrHeading
        ? codeSpans.slice(0, 1)
        : codeSpans.filter((span) => /^\s*(?:climier\s+)/.test(span) || (/^\s*[-*]\s+`--/.test(line) && /^\s*--/.test(span)));
      const declaration = help || declarations.length > 0 || tableOrHeading;
      const flagText = declaration ? (help ? line : declarations.join(" ")) : "";
      for (const match of flagText.matchAll(/--([a-z][a-z0-9-]*)\b/g)) {
        if (!allowed.has(match[1])) {
          issue(issues, file, index + 1, `${currentCommand}: --${match[1]} no es superficie v1 (permitidas: ${[...allowed].toSorted().map((x) => `--${x}`).join(", ")})`);
        }
      }
    }

    for (const match of line.matchAll(/\bentry\.([a-z][a-z0-9_]*)\b/g)) {
      if (!REFERENCE_FIELDS.includes(match[1])) {
        issue(issues, file, index + 1, `history: entry.${match[1]} no es referencia canonica (permitidas: ${REFERENCE_FIELDS.map((x) => `entry.${x}`).join(", ")})`);
      }
    }
  }
}

function validateUpdateSection(text, file, issues) {
  const heading = /^###\s+`update\b/;
  const lines = text.split(/\r?\n/);
  let inUpdate = false;
  const documented = [];
  for (const line of lines) {
    if (heading.test(line)) {
      inUpdate = true;
      continue;
    }
    if (inUpdate && /^###\s+/.test(line)) break;
    if (!inUpdate) continue;
    for (const match of line.matchAll(/`--([a-z][a-z0-9-]*)\b[^`]*`/g)) {
      documented.push(match[1]);
    }
  }
  const union = new Set([...TASK_PATCH_KEYS, ...GATE_PATCH_KEYS, ...KNOWLEDGE_PATCH_KEYS]);
  for (const flag of documented) {
    if (["as", "if-revision"].includes(flag)) continue;
    const mapped = UPDATE_FLAG_TO_KEY[flag] ?? flag.replaceAll("-", "_");
    const key = mapped.startsWith("scope.") ? "scope" : mapped;
    if (!union.has(key)) {
      issue(issues, file, lines.findIndex((line) => line.includes(`--${flag}`)) + 1, `update: --${flag} no corresponde a ninguna allowlist de provider`);
    }
  }
}

async function scanCi(root, issues, commands, flagsByCommand) {
  const file = ".github/workflows/ci.yml";
  const content = await fs.readFile(path.join(root, file), "utf8");
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/npm\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
      if (!Object.hasOwn(packageJson.scripts ?? {}, match[1])) {
        issue(issues, file, index + 1, `npm run ${match[1]} no existe en package.json`);
      }
    }
  }
  scanText(content, file, { flagsByCommand, commands, issues });
}

export async function scanRetiredSurfaces({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), helpText = HELP_TEXT } = {}) {
  const flagsByCommand = await canonicalFlags();
  const commands = new Set(KNOWN_COMMANDS);
  const issues = [];
  scanText(helpText, "HELP_TEXT", { flagsByCommand, commands, issues, help: true });
  for (const relative of TARGETS.filter((target) => target !== ".github/workflows/ci.yml")) {
    const file = path.join(root, relative);
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    scanText(content, relative, { flagsByCommand, commands, issues, persistent: relative === "docs/reference.md" });
    if (relative === "docs/reference.md") validateUpdateSection(content, relative, issues);
  }
  await scanCi(root, issues, commands, flagsByCommand);
  return { issues, checked: TARGETS.length + 1 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootArgument = process.argv.indexOf("--root");
  const root = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : undefined;
  const result = await scanRetiredSurfaces({ root });
  if (result.issues.length > 0) {
    for (const item of result.issues) console.error(item);
    process.exitCode = 1;
  } else {
    console.log(`retired surface check: ${result.checked} sources clean`);
  }
}

export const UPDATE_PATCH_KEYS = Object.freeze({
  task: [...TASK_PATCH_KEYS].toSorted(),
  gate: [...GATE_PATCH_KEYS].toSorted(),
  knowledge: [...KNOWLEDGE_PATCH_KEYS].toSorted(),
});
