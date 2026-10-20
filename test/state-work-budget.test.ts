import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createTempProject, importFresh, readState, rmTempProject, stateFilePath, writeCanonicalState } from "./helpers.ts";
import { ledgerFile } from "../src/storage/ledger.ts";

function baseState() {
  return {
    version: 1,
    revision: 0,
    fence_generation: 1,
    initiatives: { work: { desc: "work", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "before",
        initiative: "work",
        status: "open",
        revision: 1,
      },
    },
    edges: [],
    log: [],
  };
}

function updateProvider(events: string[] = []) {
  return {
    async prepare() {
      events.push("prepare");
      return { target: { id: "T1", kind: "resolvable", subkind: "task" } };
    },
    async apply({ tx }) {
      events.push("apply");
      tx.updateNode("T1", { title: "after" });
      return { result: { ok: true } };
    },
  };
}

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

function isState(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return false; }
  const state = value as Record<string, unknown>;
  return state.version === 1 && state.nodes !== undefined && state.edges !== undefined
    && state.initiatives !== undefined && state.log !== undefined;
}

test("one mutation stays within the state JSON parse and serialization budget", async () => {
  const { mutate } = await importFresh("../src/kernel/mutate.ts");
  await withProject(async (projectDir) => {
    await writeCanonicalState(projectDir, {
      ...baseState(),
      plugins: { "budget.fixture": { data: "x".repeat(128 * 1024) } },
    });
    const statePath = stateFilePath(projectDir);
    const stateBytes = (await fs.readFile(statePath)).byteLength;
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    let stateParses = 0;
    let stateSerializedBytes = 0;
    JSON.parse = function (text, reviver) {
      const result = originalParse.call(this, text, reviver);
      if (isState(result)) { stateParses += 1; }
      return result;
    };
    JSON.stringify = function (value, replacer, space) {
      const result = originalStringify.call(this, value, replacer, space);
      if (isState(value)) { stateSerializedBytes += Buffer.byteLength(result); }
      return result;
    };
    try {
      await mutate({
        projectDir,
        request: { action: "task.update", actor: "worker", input: {} },
        provider: updateProvider(),
      });
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
    assert.ok(stateParses <= 2, `expected at most 2 state parses, observed ${stateParses}`);
    assert.ok(stateSerializedBytes <= 2 * stateBytes,
      `expected at most ${2 * stateBytes} serialized state bytes, observed ${stateSerializedBytes}`);
    assert.equal((await readState(projectDir)).nodes.T1.title, "after");
  });
});

test("ledger consistency is validated at persistence after prepare, policy, and apply", async () => {
  const { mutate } = await importFresh("../src/kernel/mutate.ts");
  await withProject(async (projectDir) => {
    await writeCanonicalState(projectDir, baseState());
    const path = ledgerFile(projectDir);
    const ledger = JSON.parse(await fs.readFile(path, "utf8"));
    ledger.high_water_revision += 1;
    await fs.writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    const events: string[] = [];
    await assert.rejects(mutate({
      projectDir,
      request: { action: "task.update", actor: "worker", input: {} },
      provider: updateProvider(events),
      policyAction: {
        async decide() {
          events.push("policy");
          return { decision: "allow" };
        },
      },
    }), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });

    assert.deepEqual(events, ["prepare", "policy", "apply"]);
    assert.equal((await readState(projectDir)).nodes.T1.title, "before");
  });
});
