// --body-file: long bodies live in a markdown file, not in argv.
// Agents write the spec to a temp file and cite its path so the CLI call
// stays small and the context window stays intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

async function seedInitiative(dir) {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  await addInit({ statePath: dir, flags: { desc: "" }, positional: ["migration"] });
}

async function writeBody(dir, name, content) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

test("add-task: --body-file stores the file content as body", async () => {
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    const file = await writeBody(dir, "spec.md", "# Spec\n\nLong body here.\n");
    const out = await addTask({
      statePath: dir,
      flags: { initiative: "migration", title: "t", "body-file": file, acceptance: "done", "blocked-by": "" },
      positional: ["T1"],
    });
    assert.equal(out.node.body, "# Spec\n\nLong body here.\n");
    const s = await readState(dir);
    assert.equal(s.nodes.T1.body, "# Spec\n\nLong body here.\n");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --body and --body-file together are rejected", async () => {
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    const file = await writeBody(dir, "spec.md", "x");
    await assert.rejects(
      () => addTask({
        statePath: dir,
        flags: { initiative: "migration", title: "t", body: "inline", "body-file": file, acceptance: "done", "blocked-by": "" },
        positional: ["T1"],
      }),
      (err) => err.code === "INVALID_EXECUTION_CONTRACT" && /body-file/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: missing --body-file fails loudly", async () => {
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    await assert.rejects(
      () => addTask({
        statePath: dir,
        flags: { initiative: "migration", title: "t", "body-file": path.join(dir, "nope.md"), acceptance: "done", "blocked-by": "" },
        positional: ["T1"],
      }),
      (err) => err.code === "INVALID_EXECUTION_CONTRACT" && /add-task/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: empty --body-file still enforces required body", async () => {
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    const file = await writeBody(dir, "empty.md", "   ");
    await assert.rejects(
      () => addTask({
        statePath: dir,
        flags: { initiative: "migration", title: "t", "body-file": file, acceptance: "done", "blocked-by": "" },
        positional: ["T1"],
      }),
      (err) => err.code === "MISSING_FIELD",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --body-file patches the body", async () => {
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const { default: update } = await importFresh("./cli/commands/update.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    await addTask({
      statePath: dir,
      flags: { initiative: "migration", title: "t", body: "old", acceptance: "done", "blocked-by": "" },
      positional: ["T1"],
    });
    const file = await writeBody(dir, "new.md", "new body from file");
    const out = await update({ statePath: dir, flags: { "body-file": file, as: "alice" }, positional: ["T1"] });
    assert.equal(out.node.body, "new body from file");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate: --body-file stores the file content as body", async () => {
  const { default: addGate } = await importFresh("./cli/commands/add-gate.mjs");
  const dir = await createTempProject();
  try {
    await seedInitiative(dir);
    const file = await writeBody(dir, "gate.md", "gate context");
    const out = await addGate({
      statePath: dir,
      flags: { initiative: "migration", title: "g", "body-file": file, purpose: "decision" },
      positional: ["G1"],
    });
    assert.equal(out.node.body, "gate context");
  } finally {
    await rmTempProject(dir);
  }
});
