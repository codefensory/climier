import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { append } from "../src/storage/log.mjs";
import { checkStateRevision } from "../src/kernel/mutation/preconditions.mjs";
import { stateFile } from "../src/storage/state.mjs";
import { ledgerFile } from "../src/storage/ledger.mjs";
import { createTempProject, rmTempProject, runCli, writeFencedState } from "./helpers.mjs";

async function createFencedProject(t) {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  const projectId = `migrate-fenced-${path.basename(projectDir)}`;
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
  const fixture = {
    version: 5,
    nodes: {
      T1: { id: "T1", revision: 2, title: "first" },
      T2: { id: "T2", revision: 3, title: "second" },
    },
    edges: [],
    initiatives: {},
    log: [{ action: "seed", agent: "test" }],
    revision: 3,
  };
  await writeFencedState(projectDir, fixture);
  const resolvedStatePath = stateFile(projectDir);
  const resolvedLedgerPath = ledgerFile(projectDir);
  const tempHome = path.resolve(process.env.CLIMIER_HOME);
  assert.ok(path.resolve(resolvedStatePath).startsWith(`${tempHome}${path.sep}`),
    `fixture state must live under isolated CLIMIER_HOME: ${resolvedStatePath}`);
  assert.ok(path.resolve(resolvedLedgerPath).startsWith(`${tempHome}${path.sep}`),
    `fixture ledger must live under isolated CLIMIER_HOME: ${resolvedLedgerPath}`);
  // The shared fixture helper follows the current canonical bootstrap. Install

  const canonical = JSON.parse(await fs.readFile(resolvedStatePath, "utf8"));
  const ledger = JSON.parse(await fs.readFile(resolvedLedgerPath, "utf8"));
  await fs.writeFile(resolvedStatePath, `${JSON.stringify({
    ...canonical,
    ...fixture,
    version: 5,
    fence_generation: ledger.fence_generation,
    revision: ledger.high_water_revision,
    nodes: canonical.nodes,
  }, null, 2)}\n`);
  return { projectDir, statePath: resolvedStatePath, ledgerPath: resolvedLedgerPath };
}

async function migrate(projectDir, extraFlags = []) {
  return runCli(["--project", projectDir, "migrate", ...extraFlags], {
    env: { CLIMIER_HOME: process.env.CLIMIER_HOME },
  });
}

test("fenced migrate preserves node CAS, advances state and ledger revisions, logs once, and is idempotent", async (t) => {
  const { projectDir, statePath, ledgerPath } = await createFencedProject(t);
  const beforeState = JSON.parse(await fs.readFile(statePath, "utf8"));
  const beforeLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  const beforeNodeCount = Object.keys(beforeState.nodes).length;
  const beforeNodeRevisions = Object.fromEntries(Object.entries(beforeState.nodes).map(([id, node]) => [id, node.revision]));
  const beforeLogCount = beforeState.log.length;
  const beforeStateRevision = beforeState.revision;
  const beforeHighWater = beforeLedger.high_water_revision;

  const first = await migrate(projectDir);
  assert.equal(first.code, 0, first.stdout);
  let state = JSON.parse(await fs.readFile(statePath, "utf8"));
  let ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.fence_generation, beforeState.fence_generation);
  assert.equal(state.revision, beforeStateRevision + 1, "schema migration advances the state revision monotonically");
  assert.equal(Object.keys(state.nodes).length, beforeNodeCount);
  assert.deepEqual(Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, node.revision])), beforeNodeRevisions);
  assert.equal(state.log.length, beforeLogCount + 1);
  assert.equal(state.log.at(-1).action, "migrate");
  assert.equal(state.log.at(-1).agent, "migrate");
  assert.equal(ledger.high_water_revision, state.revision, "ledger high-water must agree with new state revision");
  assert.equal(ledger.high_water_revision, beforeHighWater + 1);
  assert.equal(ledger.high_water_revision, state.revision);
  assert.equal(ledger.fence_generation, beforeLedger.fence_generation);
  const { commit_pending: _beforePending, high_water_revision: _beforeHighWater, ...beforeLedgerStable } = beforeLedger;
  const { commit_pending: _afterPending, high_water_revision: _afterHighWater, ...afterLedgerStable } = ledger;
  assert.deepEqual(afterLedgerStable, beforeLedgerStable, "migration must preserve ledger counters and markers");
  assert.notEqual(state.revision, beforeStateRevision, "pre-import state revision token is stale");
  assert.throws(() => checkStateRevision(beforeStateRevision, state, "migrate test"), { code: "STATE_REVISION_CONFLICT" });

  const migratedRaw = await fs.readFile(statePath, "utf8");
  const migratedLedgerRaw = await fs.readFile(ledgerPath);
  const second = await migrate(projectDir);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(await fs.readFile(statePath, "utf8"), migratedRaw, "a second migrate must not change state bytes");
  assert.deepEqual(await fs.readFile(ledgerPath), migratedLedgerRaw, "a second migrate must not change ledger bytes");

  await append(projectDir, { action: "after-migrate", agent: "test" });
  state = JSON.parse(await fs.readFile(statePath, "utf8"));
  ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.log.length, beforeLogCount + 2);
  assert.equal(ledger.high_water_revision, state.revision);
  assert.equal(state.nodes.T1.revision, beforeNodeRevisions.T1);
});

test("migrate --dry-run does not write a fenced project", async (t) => {
  const { projectDir, statePath, ledgerPath } = await createFencedProject(t);
  const stateBefore = await fs.readFile(statePath);
  const ledgerBefore = await fs.readFile(ledgerPath);
  const result = await migrate(projectDir, ["--dry-run"]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(await fs.readFile(statePath), stateBefore);
  assert.deepEqual(await fs.readFile(ledgerPath), ledgerBefore);
});

test("migrate refuses an incompatible version without modifying state or ledger", async (t) => {
  const { projectDir, statePath, ledgerPath } = await createFencedProject(t);
  const incompatible = JSON.parse(await fs.readFile(statePath, "utf8"));
  incompatible.version = 6;
  await fs.writeFile(statePath, `${JSON.stringify(incompatible, null, 2)}\n`);
  const beforeState = await fs.readFile(statePath);
  const beforeLedger = await fs.readFile(ledgerPath);

  const result = await migrate(projectDir);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /unsupported|incompatible|failed/i);
  assert.deepEqual(await fs.readFile(statePath), beforeState);
  assert.deepEqual(await fs.readFile(ledgerPath), beforeLedger);
});
