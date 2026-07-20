import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DOC = path.resolve(import.meta.dirname, "..", "docs", "v2.md");
const README = path.resolve(import.meta.dirname, "..", "README.md");

const REQUIRED_SNIPPETS = [
  "# climier v2",
  "init --v2",
  "version: 2",
  "nodes",
  "edges",
  "initiatives",
  "log",
  "kind: \`resolvable\`",
  "kind: \`knowledge\`",
  "subkind: \`task\`",
  "subkind: \`gate\`",
  "BLOCKS",
  "SUPERSEDES",
  "DERIVED_FROM",
  "{ from: blocker, to: blocked, type: \"BLOCKS\" }",
  "--blocked-by \"\"",
  "CLIMIER_AGENT",
  "--if-revision",
  "take <id>",
  "resolve <id>",
  "release <id>",
  "reopen <id>",
  "cancel <id>",
  "deprecate-knowledge <id>",
  "context <id>",
  "search \"<query>\"",
  "show <id>",
  "history <id>",
  "add-initiative <name>",
  "add-task [id]",
  "add-gate [id]",
  "add-knowledge [id]",
  "add-node <id>",
  "add-edge <from> <to>",
  "add-note <id>",
  "status",
  "initiatives",
  "{ node, context, freshly_claimed }",
  "{ node, newly_ready }",
  "{ type, node }",
  "summary",
  "allowed_actions",
  "MISSING_FIELD",
  "NOT_READY",
  "ALREADY_CLAIMED",
  "NOT_OWNER",
  "REVISION_CONFLICT",
  "add-decision",
  "add-gotcha",
];

test("v2 docs: docs/v2.md exists and covers the implemented v2 surface", async () => {
  const text = await readFile(DOC, "utf8");
  for (const snippet of REQUIRED_SNIPPETS) {
    assert.match(text, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `docs/v2.md should mention ${snippet}`);
  }
});

test("v2 docs: README links to the dedicated v2 documentation", async () => {
  const text = await readFile(README, "utf8");
  assert.match(text, /docs\/v2\.md/, "README.md should link to docs/v2.md");
});
