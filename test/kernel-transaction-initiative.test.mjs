// test/kernel-transaction-initiative.test.mjs — typed initiative primitives
// for the kernel draft.
//
// Scope (B1b extension, task T-graph-kernel-core-transaction):
//   - createTransaction exposes `getInitiative` and `createInitiative` and
//     reflects the snapshot's initiatives into the draft.
//   - The draft is isolated: caller mutations on snapshot / draft / view
//     never leak.
//   - view() includes the merged (snapshot + draft) initiatives map.
//   - createInitiative refuses duplicates against snapshot + draft.
//   - The forbidden-import surface stays narrow (../errors.mjs only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTransaction } from "../src/kernel/transaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.resolve(__dirname, "..", "src", "kernel", "transaction.mjs");

function baseSnapshot() {
  return {
    version: 2,
    nodes: {},
    edges: [],
    initiatives: {
      kernel: { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" },
    },
    log: [],
  };
}

test("createTransaction: drafts initiatives from the snapshot (clone isolation)", () => {
  const snapshot = baseSnapshot();
  const tx = createTransaction(snapshot);

  // Snapshot initiative must be reachable via getInitiative and cloned.
  const seen = tx.getInitiative("kernel");
  assert.ok(seen, "snapshot initiative must be present in the draft");
  assert.deepEqual(seen, { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" });

  // Mutating the caller's snapshot must not affect the draft.
  snapshot.initiatives.kernel.desc = "tampered";
  snapshot.initiatives["leak"] = { desc: "leak" };
  delete snapshot.initiatives.kernel;
  assert.deepEqual(tx.getInitiative("kernel"), { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(tx.getInitiative("leak"), undefined);
});

test("createTransaction: getInitiative returns a clone (no draft pollution)", () => {
  const tx = createTransaction(baseSnapshot());
  const a = tx.getInitiative("kernel");
  const b = tx.getInitiative("kernel");
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "getInitiative must clone to prevent draft pollution");
  a.desc = "tampered";
  assert.equal(tx.getInitiative("kernel").desc, "kernel initiative");
});

test("createTransaction: getInitiative returns undefined for unknown names", () => {
  const tx = createTransaction(baseSnapshot());
  assert.equal(tx.getInitiative("missing"), undefined);
  assert.equal(tx.getInitiative(""), undefined);
  assert.equal(tx.getInitiative(null), undefined);
});

test("createTransaction: createInitiative registers a new initiative in the draft", () => {
  const tx = createTransaction(baseSnapshot());
  const input = { name: "auth", desc: "auth migration" };
  const returned = tx.createInitiative(input);

  // Returned value must be a clone (no shared reference with input).
  assert.notEqual(returned, input);
  assert.deepEqual(returned, { desc: "auth migration" });

  // Draft must surface the new initiative.
  const fetched = tx.getInitiative("auth");
  assert.deepEqual(fetched, { desc: "auth migration" });

  // Caller's input must not have been mutated.
  assert.deepEqual(input, { name: "auth", desc: "auth migration" });
});

test("createTransaction: createInitiative accepts an optional created_at", () => {
  const tx = createTransaction(baseSnapshot());
  const returned = tx.createInitiative({
    name: "qa",
    desc: "qa flow",
    created_at: "2026-02-02T02:02:02.000Z",
  });
  assert.deepEqual(returned, { desc: "qa flow", created_at: "2026-02-02T02:02:02.000Z" });
});

test("createTransaction: createInitiative rejects duplicates (snapshot + draft)", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.createInitiative({ name: "kernel", desc: "dup-with-snapshot" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "ID_CONFLICT");
  assert.equal(caught.details.name, "kernel");

  // After a successful createInitiative, repeating the same name is also rejected.
  tx.createInitiative({ name: "auth", desc: "first" });
  let caught2;
  try {
    tx.createInitiative({ name: "auth", desc: "second" });
  } catch (err) {
    caught2 = err;
  }
  assert.equal(caught2.code, "ID_CONFLICT");
  assert.equal(caught2.details.name, "auth");
});

test("createTransaction: createInitiative validates name and input", () => {
  const tx = createTransaction(baseSnapshot());
  // Missing input object.
  assert.throws(() => tx.createInitiative(), (err) => err.code === "MISSING_FIELD" && err.details.field === "input");
  // Missing name.
  assert.throws(() => tx.createInitiative({ desc: "no name" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "name");
  // Empty name.
  assert.throws(() => tx.createInitiative({ name: "", desc: "empty name" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "name");
  // Non-string desc is coerced to empty string (matches add-initiative
  // behaviour where --desc "" is the default).
  const returned = tx.createInitiative({ name: "ok", desc: undefined });
  assert.deepEqual(returned, {});
});

test("view: includes initiatives (snapshot + draft)", () => {
  const tx = createTransaction(baseSnapshot());
  tx.createInitiative({ name: "auth", desc: "auth migration" });
  const view = tx.view();
  assert.ok(view.initiatives, "view must include initiatives");
  assert.deepEqual(view.initiatives, {
    kernel: { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" },
    auth: { desc: "auth migration" },
  });
  // isolation: mutating view must not affect the draft.
  view.initiatives.auth.desc = "tampered";
  assert.equal(tx.getInitiative("auth").desc, "auth migration");
});

test("isolation: mutating view() does not affect the draft initiatives", () => {
  const tx = createTransaction(baseSnapshot());
  const view = tx.view();
  delete view.initiatives.kernel;
  view.initiatives["leak"] = { desc: "leak" };
  view.initiatives.kernel = { desc: "tampered" };
  const fresh = tx.view();
  assert.deepEqual(fresh.initiatives.kernel, { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(fresh.initiatives.leak, undefined);
});

test("isolation: input to createInitiative is not mutated by the kernel", () => {
  const tx = createTransaction(baseSnapshot());
  const input = { name: "iso", desc: "iso input" };
  const snapshot = JSON.parse(JSON.stringify(input));
  tx.createInitiative(input);
  assert.deepEqual(input, snapshot);
});

test("isolation: createTransaction tolerates missing initiatives in the snapshot", () => {
  const tx = createTransaction({ version: 2, nodes: {}, edges: [], log: [] });
  assert.equal(tx.getInitiative("anything"), undefined);
  const view = tx.view();
  assert.deepEqual(view.initiatives, {});
});

test("forbidden imports: transaction.mjs still only imports ../errors.mjs", async () => {
  const src = await readFile(SRC_FILE, "utf8");
  // Whitelist must remain narrow: only ../errors.mjs is allowed.
  const relativeImports = [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
  for (const imp of relativeImports) {
    assert.equal(imp, "../errors.mjs", `transaction.mjs must only import "../errors.mjs"; got ${imp}`);
  }
});
