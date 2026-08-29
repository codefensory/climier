// test/provider-core-initiative.test.mjs — pure unit tests for the
// `initiative.create` core provider
// (T-graph-kernel-provider-core-initiative).
//
// Scope:
//   - prepare is read-only; validates input shape, the canonical
//     `name` shape (mirrors the legacy add-initiative contract —
//     `^[A-Za-z0-9_-]+$`), optional `desc`, and rejects duplicates
//     already present in the snapshot;
//   - apply only touches tx.createInitiative (no fs/lock/state/log/
//     handler / argv / revision);
//   - plan carries `{ target, policyAction, logAction, initiative }`
//     and `target.id` is the initiative name (so kernel.mutate can
//     build the log entry without learning the initiative domain).
//
// Pure: no filesystem, no lock, no state, no log, no policy, no
// command, no adapter, no CLI, no UI. Snapshots and tx stubs are
// literal JS objects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const ACTOR = "codex-worker";

async function importInitiativeProvider() {
  return importFresh("../src/providers/core/initiative.mjs");
}

function makeSnapshot({ nodes = {}, edges = [], initiatives = {}, log = [] } = {}) {
  return { version: 2, initiatives, nodes, edges, log };
}

function makeRequest({ input, action = "initiative.create", actor = ACTOR } = {}) {
  return { action, actor, input };
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// makeTxStub — captures createInitiative invocations and enforces the
// structural validation that src/kernel/transaction.mjs#createInitiative
// already does, so the provider's happy path is exercised end-to-end
// without touching the real tx layer.
function makeTxStub({ initiatives = {} } = {}) {
  const draft = {};
  for (const [name, init] of Object.entries(initiatives)) {
    draft[name] = { ...init };
  }
  return {
    calls: { createInitiative: 0, view: 0 },
    draft,
    createInitiative(input) {
      this.calls.createInitiative += 1;
      if (input == null || typeof input !== "object" || Array.isArray(input)) {
        const err = new Error("txStub: input must be an object");
        err.code = "MISSING_FIELD";
        throw err;
      }
      const name = typeof input.name === "string" && input.name.length > 0 ? input.name : null;
      if (!name) {
        const err = new Error("txStub: requires non-empty 'name'");
        err.code = "MISSING_FIELD";
        throw err;
      }
      if (Object.prototype.hasOwnProperty.call(this.draft, name)) {
        const err = new Error(`txStub: initiative '${name}' already exists in the draft or snapshot`);
        err.code = "ID_CONFLICT";
        throw err;
      }
      const stored = {};
      if (typeof input.desc === "string") stored.desc = input.desc;
      if (typeof input.created_at === "string") stored.created_at = input.created_at;
      this.draft[name] = stored;
      return { ...stored };
    },
    view() {
      this.calls.view += 1;
      return { nodes: {}, edges: [], initiatives: { ...this.draft } };
    },
  };
}

async function expectCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.code, code, `expected ${code} got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected throw with code ${code}`);
}

test("initiative.create: prepare validates input shape (object)", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  await expectCode(
    () => initiativeCreateProvider.prepare({ snapshot, input: null, request: makeRequest({ input: null }) }),
    "INVALID_EXECUTION_CONTRACT",
  );
  await expectCode(
    () => initiativeCreateProvider.prepare({ snapshot, input: "auth", request: makeRequest({ input: "auth" }) }),
    "INVALID_EXECUTION_CONTRACT",
  );
  await expectCode(
    () => initiativeCreateProvider.prepare({ snapshot, input: [], request: makeRequest({ input: [] }) }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("initiative.create: prepare validates name presence and pattern", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  await expectCode(
    () => initiativeCreateProvider.prepare({ snapshot, input: {}, request: makeRequest({ input: {} }) }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      initiativeCreateProvider.prepare({
        snapshot,
        input: { name: "" },
        request: makeRequest({ input: { name: "" } }),
      }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      initiativeCreateProvider.prepare({
        snapshot,
        input: { name: 42 },
        request: makeRequest({ input: { name: 42 } }),
      }),
    "MISSING_FIELD",
  );
  // Non-conforming characters are rejected with INVALID_NAME; the
  // pattern matches the legacy add-initiative whitelist.
  for (const bad of ["has space", "with.dot", "with/slash", "with$dollar"]) {
    await expectCode(
      () =>
        initiativeCreateProvider.prepare({
          snapshot,
          input: { name: bad },
          request: makeRequest({ input: { name: bad } }),
        }),
      "INVALID_NAME",
    );
  }
});

test("initiative.create: prepare validates desc type when present", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  await expectCode(
    () =>
      initiativeCreateProvider.prepare({
        snapshot,
        input: { name: "auth", desc: 42 },
        request: makeRequest({ input: { name: "auth", desc: 42 } }),
      }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("initiative.create: prepare rejects duplicate name against snapshot", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot({
    initiatives: { auth: { desc: "auth migration", created_at: "2026-01-01T00:00:00.000Z" } },
  });
  await expectCode(
    () =>
      initiativeCreateProvider.prepare({
        snapshot,
        input: { name: "auth", desc: "dup" },
        request: makeRequest({ input: { name: "auth", desc: "dup" } }),
      }),
    "ID_CONFLICT",
  );
});

test("initiative.create: prepare returns frozen plan with target, policyAction, logAction, initiative", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  const input = { name: "auth", desc: "auth migration" };
  const request = makeRequest({ input });
  const plan = await initiativeCreateProvider.prepare({ snapshot, input, request });

  assert.equal(plan.target.id, "auth", "target.id must be the initiative name");
  assert.equal(plan.target.kind, "initiative", "target.kind signals initiative domain");
  assert.equal(plan.policyAction.action, "initiative.create");
  assert.equal(plan.policyAction.pluginId, null);
  assert.equal(plan.logAction, "add-initiative");
  assert.equal(plan.initiative.name, "auth");
  assert.equal(plan.initiative.desc, "auth migration");
  assert.match(plan.initiative.created_at, /^\d{4}-\d{2}-\d{2}T/, "created_at stamped at prepare time");
  assert.ok(Object.isFrozen(plan), "plan must be frozen");
  assert.ok(Object.isFrozen(plan.target), "plan.target must be frozen");
  assert.ok(Object.isFrozen(plan.initiative), "plan.initiative must be frozen");
  assert.ok(Object.isFrozen(plan.policyAction), "plan.policyAction must be frozen");
});

test("initiative.create: prepare does not touch the snapshot (read-only invariant)", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const initiatives = { existing: { desc: "x", created_at: "2026-01-01T00:00:00.000Z" } };
  const snapshot = makeSnapshot({ initiatives });
  const before = JSON.stringify(snapshot);
  await initiativeCreateProvider.prepare({
    snapshot,
    input: { name: "auth", desc: "auth migration" },
    request: makeRequest({ input: { name: "auth", desc: "auth migration" } }),
  });
  assert.equal(JSON.stringify(snapshot), before, "snapshot must not be mutated by prepare");
});

test("initiative.create: apply calls tx.createInitiative exactly once with the planned payload", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  const input = { name: "auth", desc: "auth migration" };
  const request = makeRequest({ input });
  const plan = await initiativeCreateProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub();
  const result = await initiativeCreateProvider.apply({
    tx,
    plan,
    input,
    request,
    snapshot,
  });

  assert.equal(tx.calls.createInitiative, 1, "apply must call tx.createInitiative exactly once");
  assert.equal(tx.calls.view, 0, "apply must not call tx.view");
  assert.equal(result.effects, null);
  assert.deepEqual(tx.draft, {
    auth: {
      desc: "auth migration",
      created_at: plan.initiative.created_at,
    },
  });
  assert.equal(result.result.name, "auth");
  assert.equal(result.result.desc, "auth migration");
  assert.match(result.result.created_at, /^\d{4}-\d{2}-\d{2}T/);
  // The apply result must never carry a revision; the kernel owns it.
  assert.equal(result.result.revision, undefined);
});

test("initiative.create: apply rejects without tx.createInitiative", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  const input = { name: "auth" };
  const plan = await initiativeCreateProvider.prepare({
    snapshot,
    input,
    request: makeRequest({ input }),
  });
  await expectCode(
    () =>
      initiativeCreateProvider.apply({
        tx: {},
        plan,
        input,
        request: makeRequest({ input }),
        snapshot,
      }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("initiative.create: plan is consumable end-to-end by kernel.mutate (no second persistence path)", async () => {
  // Pure provider contract smoke: a synthesized plan consumed by the
  // stub tx exercises the same code path as the kernel without
  // needing to spin up a temp project. Validates that apply mirrors
  // the kernel's expectation that `tx.createInitiative` is the only
  // mutating call and that the plan shape matches what the kernel
  // passes through.
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  const input = { name: "auth", desc: "auth migration" };
  const request = makeRequest({ input });
  const plan = await initiativeCreateProvider.prepare({ snapshot, input, request });

  // The kernel validates plan.target.id (non-empty string) and passes
  // plan through unchanged. Replicate those minimal expectations here.
  assert.equal(typeof plan.target.id, "string");
  assert.ok(plan.target.id.length > 0);
  assert.equal(plan.target.id, plan.initiative.name);

  // apply must mutate only via tx.createInitiative; the tx stub
  // captures exactly one invocation with the planned payload.
  const tx = makeTxStub();
  await initiativeCreateProvider.apply({ tx, plan, input, request, snapshot });
  assert.equal(tx.calls.createInitiative, 1);
  assert.equal(Object.keys(tx.draft).length, 1);
});

test("initiative.create: legacy name pattern admits the canonical initiative names used in this repo", async () => {
  const { initiativeCreateProvider } = await importInitiativeProvider();
  const snapshot = makeSnapshot();
  for (const name of ["auth", "migration", "kernel", "plugin-platform", "phase-1"]) {
    assert.ok(NAME_PATTERN.test(name), `${name} must match ${NAME_PATTERN}`);
    const plan = await initiativeCreateProvider.prepare({
      snapshot,
      input: { name, desc: `desc for ${name}` },
      request: makeRequest({ input: { name, desc: `desc for ${name}` } }),
    });
    assert.equal(plan.initiative.name, name);
  }
});