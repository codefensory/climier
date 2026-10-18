// --help must document every flag the command actually accepts. The flag
// inventory is the generated contract (src/contracts/generated/commands.ts),
// so a new flag that skips the help text fails here.
import { test } from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT } from "../src/cli/dispatch-constants.ts";
import { GENERATED_COMMAND_FLAGS } from "../src/contracts/generated/commands.ts";

// Every command accepts these; they live in the Global flags block.
const GLOBAL_FLAGS = new Set(["as", "project", "no-warnings"]);

export function helpBlocks(text: string) {
  const blocks: Record<string, Set<string>> = {};
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const entry = line.match(/^ {2}([a-zA-Z][a-z0-9-]*)/);
    if (entry) {
      current = entry[1] in GENERATED_COMMAND_FLAGS ? entry[1] : null;
    }
    if (current === null) {
      continue;
    }
    blocks[current] ??= new Set();
    for (const match of line.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)) {
      blocks[current].add(match[1]);
    }
  }
  return blocks;
}

test("--help documents every accepted flag of every command", () => {
  const blocks = helpBlocks(HELP_TEXT);
  const gaps: string[] = [];
  for (const [command, flags] of Object.entries(GENERATED_COMMAND_FLAGS)) {
    const documented = blocks[command];
    if (!documented) {
      gaps.push(`${command}: no help block`);
      continue;
    }
    for (const flag of flags) {
      if (!GLOBAL_FLAGS.has(flag) && !documented.has(flag)) {
        gaps.push(`${command}: --${flag}`);
      }
    }
  }
  assert.deepEqual(gaps, []);
});
