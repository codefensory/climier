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
const OPERATIONAL_DOCS = [
  "AGENTS.md",
  "README.md",
  "CLIMIER-CHEATSHEET.md",
  "docs/agent-execution-flow.md",
  "docs/reference.md",
  "docs/climier-ui.md",
  ".agents/skills/climier/SKILL.md",
  ".agents/skills/climier/examples/task-execution.md",
  ".agents/skills/climier/examples/claim-serialization.md",
  ".agents/skills/climier/examples/dag-curation.md",
  ".agents/skills/initiative-execution/SKILL.md",
  "skills/climier/SKILL.md",
  "skills/climier/references/commands.md",
].map((relativePath) => path.resolve(import.meta.dirname, "..", relativePath));

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

test("docs: climierflow recovery syntax matches the installed runner contract", async () => {
  const entries = await Promise.all(OPERATIONAL_DOCS.map(async (file) => [file, await readFile(file, "utf8")]));
  const text = entries.map(([, contents]) => contents).join("\n");

  for (const [file, contents] of entries) {
    for (const line of contents.split(/\r?\n/)) {
      const statusIndex = line.indexOf("climierflow status");
      if (statusIndex !== -1) {
        assert.match(
          line.slice(statusIndex),
          /climierflow status (?:<task-id>|T-[A-Za-z0-9._-]+)/,
          `${file} should pass a task id to climierflow status`,
        );
      }

      const resumeIndex = line.indexOf("climierflow resume");
      if (resumeIndex !== -1) {
        const command = line.slice(resumeIndex).split("`")[0];
        assert.match(
          command,
          /climierflow resume (?:<task-id>|T-[A-Za-z0-9._-]+)/,
          `${file} should pass a task id to climierflow resume`,
        );
        assert.doesNotMatch(command, /--(?!summary\b)/, `${file} should document no resume flags besides --summary`);
      }

      const restartIndex = line.indexOf("climierflow restart");
      if (restartIndex !== -1) {
        const command = line.slice(restartIndex).split("`")[0];
        assert.match(
          command,
          /climierflow restart (?:<task-id>|T-[A-Za-z0-9._-]+).*--body .*--acceptance .*--confirm-discard/,
          `${file} should document all required restart inputs`,
        );
      }
    }
  }

  assert.match(text, /climierflow resume <task-id> \[--summary TEXT\]/);
  assert.match(text, /RESTART_REQUIRES_REVIEW/);
  assert.match(text, /new correction task/i);
  assert.doesNotMatch(text, /climier reopen[^\n]*\n[^\n]*climierflow restart/);
});
