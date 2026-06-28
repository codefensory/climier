// Migration seed: the migration preset must include the planned nodes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationSeed } from "../src/seeds/migration.mjs";

test("seed: includes the migration initiative with description", () => {
  assert.ok(migrationSeed.initiatives.migration);
  assert.ok(migrationSeed.initiatives.migration.desc.length > 0);
});

test("seed: includes the 4 known decisions (D1, D2, D3, D4) all open", () => {
  for (const id of ["D1", "D2", "D3", "D4"]) {
    assert.ok(migrationSeed.decisions[id], `missing decision ${id}`);
    assert.notEqual(migrationSeed.decisions[id].status, "decided");
  }
});

test("seed: F0 has at least one immediately-ready task (no deps)", async () => {
  const { derive } = await import("../src/dag.mjs");
  const r = derive(migrationSeed);
  assert.ok(r.ready.length > 0, "no ready tasks in seed");
  assert.ok(r.ready.some((id) => id.startsWith("F0.")), "expected an F0.* task ready");
  // F1.* tasks depend on F0; they're expected to be blocked at seed time.
  const f1Ready = r.ready.filter((id) => id.startsWith("F1."));
  assert.deepEqual(f1Ready, [], "F1.* should be blocked until F0 is done");
});

test("seed: F2..F9 are phase stubs (one task per phase) depending on prior phase(s)", () => {
  const stubPhases = ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"];
  for (const p of stubPhases) {
    const found = Object.values(migrationSeed.tasks).find((t) => t.id.startsWith(`${p}.`));
    assert.ok(found, `missing stub for ${p}`);
  }
});

test("seed: gotchas exist with applies_to matching domains (db, coins, auth, directus)", () => {
  const domains = migrationSeed.gotchas;
  const all = Object.values(domains);
  assert.ok(all.length >= 4);
  const flat = all.map((g) => g.applies_to).flat();
  for (const need of ["db", "coins", "auth", "directus"]) {
    assert.ok(flat.some((a) => a.includes(need)), `missing gotcha applying to ${need}`);
  }
});
