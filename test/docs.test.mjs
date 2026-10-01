import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DOC = path.resolve(import.meta.dirname, "..", "docs", "reference.md");
const README = path.resolve(import.meta.dirname, "..", "README.md");
const SYSTEM_PROMPT = path.resolve(import.meta.dirname, "..", ".pi", "SYSTEM.md");
const APPEND_PROMPT = path.resolve(import.meta.dirname, "..", ".pi", "APPEND_SYSTEM.md");
const AGENTS = path.resolve(import.meta.dirname, "..", "AGENTS.md");
const SPEC_PIPELINE = path.resolve(import.meta.dirname, "..", ".agents", "skills", "spec-pipeline", "SKILL.md");
const INITIATIVE_EXECUTION = path.resolve(import.meta.dirname, "..", ".agents", "skills", "initiative-execution", "SKILL.md");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");

const REQUIRED_SNIPPETS = [
  "# climier reference",
  "version: 1,",
  "nodes",
  "edges",
  "initiatives",
  "log",
  "kind: `resolvable`",
  "kind: `knowledge`",
  "subkind: `task`",
  "subkind: `gate`",
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
];

test("docs: reference.md exists and covers the implemented surface", async () => {
  const text = await readFile(DOC, "utf8");
  for (const snippet of REQUIRED_SNIPPETS) {
    assert.match(text, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `reference.md should mention ${snippet}`);
  }
});

test("docs: README links to the dedicated reference documentation", async () => {
  const text = await readFile(README, "utf8");
  assert.match(text, /docs\/reference\.md/, "README.md should link to docs/reference.md");
});

test("docs: Pi guidance is append-only and workflows are opt-in", async () => {
  await assert.rejects(readFile(SYSTEM_PROMPT, "utf8"), /ENOENT/);

  const [appendPrompt, agents, specPipeline, initiativeExecution] = await Promise.all([
    readFile(APPEND_PROMPT, "utf8"),
    readFile(AGENTS, "utf8"),
    readFile(SPEC_PIPELINE, "utf8"),
    readFile(INITIATIVE_EXECUTION, "utf8"),
  ]);

  assert.ok(appendPrompt.split(/\r?\n/).length <= 40, "APPEND_SYSTEM.md should stay concise");
  for (const snippet of [
    "append-only",
    "built-in system prompt",
    ".agents/skills/spec-pipeline/SKILL.md",
    ".agents/skills/initiative-execution/SKILL.md",
    "climierflow run <task-id>",
  ]) {
    assert.match(appendPrompt, new RegExp(escapeRegExp(snippet)), `APPEND_SYSTEM.md should mention ${snippet}`);
  }

  assert.doesNotMatch(agents, /\.pi\/SYSTEM\.md/);
  for (const snippet of [
    "direct path",
    "controlled workflow is optional",
    "task already registered",
    "climierflow run <task-id>",
  ]) {
    assert.match(agents, new RegExp(escapeRegExp(snippet)), `AGENTS.md should mention ${snippet}`);
  }

  for (const snippet of ["opt-in", "cambio pequeno", "decision real", "RFC", "ADR"]) {
    assert.match(specPipeline, new RegExp(snippet, "i"), `spec-pipeline should mention ${snippet}`);
  }

  for (const snippet of [
    "opt-in",
    "one `climierflow run <task-id>` per task",
    "terminal",
    "climierflow status",
    "climierflow resume",
    "climierflow restart",
  ]) {
    assert.match(initiativeExecution, new RegExp(escapeRegExp(snippet)), `initiative-execution should mention ${snippet}`);
  }
});
