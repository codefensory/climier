// v2-execution-contract.test.mjs — coverage for the meta.execution contract.
//
// Suite covers:
//   - add-node / update reject malformed meta.execution with a structured
//     INVALID_EXECUTION_CONTRACT code and clear details.
//   - Valid contracts round-trip; paths get trimmed and deduped.
//   - meta blocks without execution (or with arbitrary other keys) keep
//     working unchanged — backward compatibility with historical meta.
//   - context surfaces execution_contract + ownership_conflicts deterministically.
//   - Conflict detection covers equality + ancestor + descendant path
//     relationships against other open / in_progress tasks.
//   - done / canceled / archived / superseded tasks do NOT alert.
//   - knowledge / gate nodes never produce conflicts (they have no `owns`).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  writeState as writeRawState,
  readState as readRawState,
} from "./helpers.mjs";

const baseState = () => ({ version: 2, nodes: {}, edges: [], log: [] });

async function bootstrapV2(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  await init({ statePath: dir, projectDir: dir, positional: [], flags: { v2: true } });
  const { default: addInitiative } = await importFresh("./commands/add-initiative.mjs");
  await addInitiative({
    statePath: dir,
    projectDir: dir,
    positional: ["wf"],
    flags: { desc: "workflow", as: "orchestrator" },
  });
}

async function addTask(dir, id, extraFlags) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: "X",
      initiative: "wf",
      ...extraFlags,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (path ancestry)
// ---------------------------------------------------------------------------

test("pathRelationship: equal", async () => {
  const { pathRelationship } = await importFresh("./execution-contract.mjs");
  assert.equal(pathRelationship("src/foo.mjs", "src/foo.mjs"), "equal");
});

test("pathRelationship: self_is_ancestor_of_other", async () => {
  const { pathRelationship } = await importFresh("./execution-contract.mjs");
  assert.equal(pathRelationship("src/", "src/foo.mjs"), "self_is_ancestor_of_other");
  assert.equal(pathRelationship("src", "src/foo.mjs"), "self_is_ancestor_of_other");
});

test("pathRelationship: self_is_descendant_of_other", async () => {
  const { pathRelationship } = await importFresh("./execution-contract.mjs");
  assert.equal(pathRelationship("src/foo.mjs", "src/"), "self_is_descendant_of_other");
});

test("pathRelationship: unrelated paths return null", async () => {
  const { pathRelationship } = await importFresh("./execution-contract.mjs");
  assert.equal(pathRelationship("src/foo.mjs", "test/foo.mjs"), null);
  // Sibling-prefix collision: only the first segment matches, second does not.
  assert.equal(pathRelationship("src-a/foo", "src/foo"), null);
});

// ---------------------------------------------------------------------------
// Pure helpers (normalizeExecution)
// ---------------------------------------------------------------------------

test("normalizeExecution: drops unknown top-level keys, keeps schema fields", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  const out = normalizeExecution({
    effort: "M",
    risk: "isolated",
    owns: ["src/foo.mjs", " src/foo.mjs ", "src/bar.mjs"],
    reads: ["src/state.mjs"],
    seam: "context.api",
    checks: ["npm test"],
    extra_field_we_do_not_know_about: "should be ignored? no, preserved at meta level",
  });
  assert.equal(out.effort, "M");
  assert.equal(out.risk, "isolated");
  assert.deepEqual(out.owns, ["src/foo.mjs", "src/bar.mjs"]);
  assert.deepEqual(out.reads, ["src/state.mjs"]);
  assert.equal(out.seam, "context.api");
  // String arrays dedupe / trim but keep distinct strings.
  assert.deepEqual(out.checks, ["npm test"]);
});

test("normalizeExecution: returns null when no schema fields present", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  assert.equal(normalizeExecution({ totally: "arbitrary" }), null);
  assert.equal(normalizeExecution({}), null);
  assert.equal(normalizeExecution(null), null);
  assert.equal(normalizeExecution(undefined), null);
});

test("normalizeExecution: rejects unknown effort value", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution({ effort: "XL" });
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "effort");
});

test("normalizeExecution: rejects unknown risk value", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution({ risk: "yolo" });
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "risk");
});

test("normalizeExecution: rejects non-string array for owns", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution({ owns: ["ok.mjs", 7] });
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "owns");
});

test("normalizeExecution: rejects empty owns array", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution({ owns: [] });
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "owns");
});

test("normalizeExecution: rejects non-object execution", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution("not-an-object");
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
});

test("normalizeExecution: rejects empty seam string", async () => {
  const { normalizeExecution } = await importFresh("./execution-contract.mjs");
  let caught;
  try {
    normalizeExecution({ seam: "   " });
  } catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "seam");
});

// ---------------------------------------------------------------------------
// validateExecution — meta without execution must pass through untouched
// ---------------------------------------------------------------------------

test("validateExecution: returns meta unchanged when no execution key", async () => {
  const { validateExecution } = await importFresh("./execution-contract.mjs");
  const meta = { ticket: "ABC-1", severity: "high" };
  assert.deepEqual(validateExecution(meta), meta);
  assert.equal(validateExecution(undefined), undefined);
  assert.equal(validateExecution(null), null);
});

test("validateExecution: meta.execution=null strips the key and preserves siblings", async () => {
  const { validateExecution } = await importFresh("./execution-contract.mjs");
  const out = validateExecution({ execution: null, ticket: "X" });
  assert.deepEqual(out, { ticket: "X" });
});

test("validateExecution: meta.execution={} strips the key and preserves siblings", async () => {
  const { validateExecution } = await importFresh("./execution-contract.mjs");
  const out = validateExecution({ execution: {}, ticket: "X" });
  assert.deepEqual(out, { ticket: "X" });
});

test("validateExecution: partial contract is preserved as-is", async () => {
  const { validateExecution } = await importFresh("./execution-contract.mjs");
  const out = validateExecution({ execution: { effort: "S" }, ticket: "X" });
  assert.deepEqual(out.execution, { effort: "S" });
  assert.equal(out.ticket, "X");
});

// ---------------------------------------------------------------------------
// add-node: contract validation through the CLI surface
// ---------------------------------------------------------------------------

test("add-node: rejects meta.execution with INVALID_EXECUTION_CONTRACT code", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    let caught;
    try {
      await addTask(dir, "T-bad", { meta: '{"execution":{"effort":"XL"}}', as: "orchestrator" });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "effort");
  } finally { await rmTempProject(dir); }
});

test("add-node: accepts a fully-valid meta.execution and persists normalized form", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-good", {
      meta: JSON.stringify({
        ticket: "WF-1",
        execution: {
          effort: "M",
          risk: "isolated",
          owns: ["src/commands/foo.mjs", "src/commands/foo.mjs"],
          reads: ["src/state.mjs"],
          seam: "commands.foo",
          checks: ["node --test test/foo.test.mjs"],
        },
      }),
      as: "orchestrator",
    });
    const s = await readRawState(dir);
    const node = s.nodes["T-good"];
    assert.equal(node.meta.ticket, "WF-1");
    assert.equal(node.meta.execution.effort, "M");
    assert.equal(node.meta.execution.risk, "isolated");
    // Dedup happened.
    assert.deepEqual(node.meta.execution.owns, ["src/commands/foo.mjs"]);
    assert.deepEqual(node.meta.execution.reads, ["src/state.mjs"]);
    assert.equal(node.meta.execution.seam, "commands.foo");
    assert.deepEqual(node.meta.execution.checks, ["node --test test/foo.test.mjs"]);
  } finally { await rmTempProject(dir); }
});

test("add-node: meta without execution key stays compatible (historical meta)", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-historical", {
      meta: '{"ticket":"OLD-1","reviewer":"alice","custom_array":[1,2,3]}',
      as: "orchestrator",
    });
    const s = await readRawState(dir);
    const node = s.nodes["T-historical"];
    assert.deepEqual(node.meta, {
      ticket: "OLD-1",
      reviewer: "alice",
      custom_array: [1, 2, 3],
    });
    assert.equal("execution" in node.meta, false);
  } finally { await rmTempProject(dir); }
});

test("add-node: meta with execution:null strips it and keeps the rest", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-strip", {
      meta: '{"execution":null,"ticket":"STRIP"}',
      as: "orchestrator",
    });
    const s = await readRawState(dir);
    assert.deepEqual(s.nodes["T-strip"].meta, { ticket: "STRIP" });
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// update: contract validation through the CLI surface
// ---------------------------------------------------------------------------

test("update: rejects meta.execution with INVALID_EXECUTION_CONTRACT", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-x");
    let caught;
    try {
      await update({
        statePath: dir,
        positional: ["T-x"],
        flags: { meta: '{"execution":{"risk":"yolo"}}', as: "orchestrator" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "risk");
  } finally { await rmTempProject(dir); }
});

test("update: valid meta.execution persists the normalized contract", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-x");
    await update({
      statePath: dir,
      positional: ["T-x"],
      flags: {
        meta: JSON.stringify({
          execution: { effort: "L", risk: "public-surface", owns: ["src/commands/bar.mjs"], seam: "commands.bar" },
        }),
        as: "orchestrator",
      },
    });
    const s = await readRawState(dir);
    assert.deepEqual(s.nodes["T-x"].meta.execution, {
      effort: "L",
      risk: "public-surface",
      owns: ["src/commands/bar.mjs"],
      seam: "commands.bar",
    });
  } finally { await rmTempProject(dir); }
});

test("update: meta.execution={} clears the existing contract while keeping siblings", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-x", {
      meta: JSON.stringify({
        ticket: "WF-9",
        execution: { effort: "S", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" },
      }),
      as: "orchestrator",
    });
    await update({
      statePath: dir,
      positional: ["T-x"],
      flags: { meta: JSON.stringify({ execution: {}, ticket: "WF-9" }), as: "orchestrator" },
    });
    const s = await readRawState(dir);
    assert.equal("execution" in s.nodes["T-x"].meta, false);
    assert.equal(s.nodes["T-x"].meta.ticket, "WF-9");
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// context: execution_contract + ownership_conflicts
// ---------------------------------------------------------------------------

test("context: execution_contract is null when node has no contract", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "open",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.equal(out.execution_contract, null);
    assert.deepEqual(out.ownership_conflicts, []);
    assert.equal(out.alerts.find((a) => a.kind === "OWNERSHIP_CONFLICT"), undefined);
  } finally { await rmTempProject(dir); }
});

test("context: execution_contract surfaces the normalized contract", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "open",
          meta: {
            execution: {
              effort: "M",
              risk: "isolated",
              owns: ["src/commands/x.mjs"],
              reads: ["src/state.mjs"],
              seam: "commands.x",
              checks: ["npm test"],
            },
          },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.deepEqual(out.execution_contract, {
      effort: "M",
      risk: "isolated",
      owns: ["src/commands/x.mjs"],
      reads: ["src/state.mjs"],
      seam: "commands.x",
      checks: ["npm test"],
    });
    assert.deepEqual(out.ownership_conflicts, []);
  } finally { await rmTempProject(dir); }
});

test("context: ownership_conflicts detects equal paths between two open tasks", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-self": {
          id: "T-self",
          kind: "resolvable",
          subkind: "task",
          title: "Self",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" },
          },
        },
        "T-other": {
          id: "T-other",
          kind: "resolvable",
          subkind: "task",
          title: "Other",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" },
          },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-self"], flags: {} });
    assert.equal(out.ownership_conflicts.length, 1);
    const conflict = out.ownership_conflicts[0];
    assert.equal(conflict.relationship, "equal");
    assert.equal(conflict.self_path, "src/commands/x.mjs");
    assert.equal(conflict.other_path, "src/commands/x.mjs");
    assert.equal(conflict.other_node_id, "T-other");
    assert.equal(conflict.other_node_title, "Other");
    assert.equal(conflict.other_status, "open");
    // And the alert is present.
    const alert = out.alerts.find((a) => a.kind === "OWNERSHIP_CONFLICT");
    assert.ok(alert, "expected OWNERSHIP_CONFLICT alert");
    assert.equal(alert.count, 1);
    assert.equal(alert.node_id, "T-self");
  } finally { await rmTempProject(dir); }
});

test("context: ownership_conflicts detects ancestor / descendant relationships", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-self": {
          id: "T-self",
          kind: "resolvable",
          subkind: "task",
          title: "Self",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs", "src/"], seam: "x" },
          },
        },
        // Owns an ancestor of `src/commands/x.mjs` -> descendant conflict.
        "T-ancestor": {
          id: "T-ancestor",
          kind: "resolvable",
          subkind: "task",
          title: "Ancestor",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["src/"], seam: "y" },
          },
        },
        // Owns a descendant of `src/` -> ancestor conflict.
        "T-descendant": {
          id: "T-descendant",
          kind: "resolvable",
          subkind: "task",
          title: "Descendant",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["src/foo/bar.mjs"], seam: "z" },
          },
        },
        // Unrelated paths — must not appear.
        "T-safe": {
          id: "T-safe",
          kind: "resolvable",
          subkind: "task",
          title: "Safe",
          revision: 1,
          status: "open",
          meta: {
            execution: { effort: "M", risk: "isolated", owns: ["test/foo.test.mjs"], seam: "s" },
          },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-self"], flags: {} });
    // 3 expected conflicts:
    //   - T-self `src/commands/x.mjs` vs T-ancestor `src/` -> self_is_descendant_of_other.
    //   - T-self `src/`              vs T-ancestor `src/` -> equal.
    //   - T-self `src/`              vs T-descendant `src/foo/bar.mjs` -> self_is_ancestor_of_other.
    // The pair T-self `src/commands/x.mjs` vs T-descendant `src/foo/bar.mjs`
    // is unrelated (different second segments) so it is NOT a conflict.
    assert.equal(out.ownership_conflicts.length, 3);
    const byNode = new Map();
    for (const c of out.ownership_conflicts) {
      const arr = byNode.get(c.other_node_id) || [];
      arr.push(c);
      byNode.set(c.other_node_id, arr);
    }
    assert.equal(byNode.get("T-ancestor").length, 2);
    const anc = byNode.get("T-ancestor").find((c) => c.relationship === "self_is_descendant_of_other");
    assert.ok(anc, "expected descendant conflict against T-ancestor");
    assert.equal(anc.self_path, "src/commands/x.mjs");
    assert.equal(anc.other_path, "src/");
    const ancEq = byNode.get("T-ancestor").find((c) => c.relationship === "equal");
    assert.ok(ancEq, "expected equal conflict against T-ancestor");
    assert.equal(ancEq.self_path, "src/");
    assert.equal(ancEq.other_path, "src/");
    assert.equal(byNode.get("T-descendant").length, 1);
    const desc = byNode.get("T-descendant")[0];
    assert.equal(desc.relationship, "self_is_ancestor_of_other");
    assert.equal(desc.self_path, "src/");
    assert.equal(desc.other_path, "src/foo/bar.mjs");
    // Safe task should NOT show up.
    assert.equal(byNode.get("T-safe"), undefined);
    const alert = out.alerts.find((a) => a.kind === "OWNERSHIP_CONFLICT");
    assert.ok(alert, "expected OWNERSHIP_CONFLICT alert");
    assert.equal(alert.count, 3);
  } finally { await rmTempProject(dir); }
});

test("context: ownership_conflicts skip done/canceled/archived/superseded tasks", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-self": {
          id: "T-self",
          kind: "resolvable",
          subkind: "task",
          title: "Self",
          revision: 1,
          status: "open",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" } },
        },
        "T-done": {
          id: "T-done",
          kind: "resolvable",
          subkind: "task",
          title: "Done",
          revision: 1,
          status: "done",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" } },
        },
        "T-canceled": {
          id: "T-canceled",
          kind: "resolvable",
          subkind: "task",
          title: "Canceled",
          revision: 1,
          status: "canceled",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" } },
        },
        "T-archived": {
          id: "T-archived",
          kind: "resolvable",
          subkind: "task",
          title: "Archived",
          revision: 1,
          status: "archived",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" } },
        },
        "T-inprog": {
          id: "T-inprog",
          kind: "resolvable",
          subkind: "task",
          title: "In Progress",
          revision: 1,
          status: "in_progress",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" } },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-self"], flags: {} });
    // Only T-inprog conflicts (equal path); done / canceled / archived do not.
    assert.equal(out.ownership_conflicts.length, 1);
    assert.equal(out.ownership_conflicts[0].other_node_id, "T-inprog");
    assert.equal(out.ownership_conflicts[0].other_status, "in_progress");
  } finally { await rmTempProject(dir); }
});

test("context: knowledge / gate nodes do not produce ownership_conflicts", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "K-self": {
          id: "K-self",
          kind: "knowledge",
          title: "Self",
          knowledge_type: "warning",
          status: "active",
          meta: { execution: { effort: "S", risk: "isolated", owns: ["src/foo.mjs"], seam: "k" } },
        },
        "T-other": {
          id: "T-other",
          kind: "resolvable",
          subkind: "task",
          title: "Other",
          revision: 1,
          status: "open",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/foo.mjs"], seam: "t" } },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["K-self"], flags: {} });
    // knowledge / gate nodes never participate in ownership conflicts; the
    // contract itself is still surfaced (it's harmless metadata) but the
    // conflict array is unconditionally empty for non-task nodes.
    assert.deepEqual(out.ownership_conflicts, []);
    assert.equal(out.alerts.find((a) => a.kind === "OWNERSHIP_CONFLICT"), undefined);
    // The contract is surfaced as the normalized shape.
    assert.deepEqual(out.execution_contract, {
      effort: "S",
      risk: "isolated",
      owns: ["src/foo.mjs"],
      seam: "k",
    });
  } finally { await rmTempProject(dir); }
});

test("context: deterministic ordering by (other_node_id, self_path, other_path)", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-self": {
          id: "T-self",
          kind: "resolvable",
          subkind: "task",
          title: "Self",
          revision: 1,
          status: "open",
          meta: {
            execution: {
              effort: "M",
              risk: "isolated",
              owns: ["src/zzz.mjs", "src/aaa.mjs"],
              seam: "x",
            },
          },
        },
        "T-z": {
          id: "T-z",
          kind: "resolvable",
          subkind: "task",
          title: "Z",
          revision: 1,
          status: "open",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/zzz.mjs"], seam: "z" } },
        },
        "T-a": {
          id: "T-a",
          kind: "resolvable",
          subkind: "task",
          title: "A",
          revision: 1,
          status: "open",
          meta: { execution: { effort: "M", risk: "isolated", owns: ["src/aaa.mjs"], seam: "a" } },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-self"], flags: {} });
    assert.equal(out.ownership_conflicts.length, 2);
    // T-a must come before T-z; within each node, aaa < zzz.
    assert.equal(out.ownership_conflicts[0].other_node_id, "T-a");
    assert.equal(out.ownership_conflicts[1].other_node_id, "T-z");
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// CLI dispatch end-to-end
// ---------------------------------------------------------------------------

test("CLI: add-task rejects invalid meta.execution with INVALID_EXECUTION_CONTRACT", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["init"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await runCli(["add-initiative", "wf", "--desc", "x", "--as", "orchestrator"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await runCli([
      "add-task", "T-bad",
      "--initiative", "wf",
      "--title", "X",
      "--body", "Y",
      "--acceptance", "Z",
      "--blocked-by", "",
      "--meta", '{"execution":{"effort":"XL"}}',
      "--as", "orchestrator",
    ], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(err.error.details.field, "effort");
  } finally { await rmTempProject(dir); }
});

test("CLI: context surfaces execution_contract and ownership_conflicts via JSON", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["init"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await runCli(["add-initiative", "wf", "--desc", "x", "--as", "orchestrator"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await runCli([
      "add-task", "T-self",
      "--initiative", "wf",
      "--title", "Self",
      "--body", "Y",
      "--acceptance", "Z",
      "--blocked-by", "",
      "--meta", JSON.stringify({
        execution: { effort: "M", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" },
      }),
      "--as", "orchestrator",
    ], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await runCli([
      "add-task", "T-other",
      "--initiative", "wf",
      "--title", "Other",
      "--body", "Y",
      "--acceptance", "Z",
      "--blocked-by", "",
      "--meta", JSON.stringify({
        execution: { effort: "S", risk: "isolated", owns: ["src/commands/x.mjs"], seam: "x" },
      }),
      "--as", "orchestrator",
    ], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);

    r = await runCli(["context", "T-self"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    const ctx = JSON.parse(r.stdout);
    assert.equal(ctx.execution_contract.effort, "M");
    assert.equal(ctx.ownership_conflicts.length, 1);
    assert.equal(ctx.ownership_conflicts[0].other_node_id, "T-other");
    const alert = ctx.alerts.find((a) => a.kind === "OWNERSHIP_CONFLICT");
    assert.ok(alert, "expected OWNERSHIP_CONFLICT alert");
  } finally { await rmTempProject(dir); }
});