import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createTempProject, importFresh, readState, rmTempProject, stateFilePath, writeCanonicalState } from "./helpers.ts";

function baseState() {
  return {
    version: 1,
    revision: 0,
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

async function measureStateWork(projectDir: string, run: () => Promise<unknown>) {
  const stateBytes = (await fs.readFile(stateFilePath(projectDir))).byteLength;
  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  const originalStructuredClone = globalThis.structuredClone;
  const work = { stateParses: 0, stateParseBytes: 0, stringifyCalls: 0, stringifiedBytes: 0, structuredClones: 0 };
  JSON.parse = function (text, reviver) {
    const result = originalParse.call(this, text, reviver);
    if (isState(result)) {
      work.stateParses += 1;
      work.stateParseBytes += Buffer.byteLength(String(text));
    }
    return result;
  };
  JSON.stringify = function (value, replacer, space) {
    const result = originalStringify.call(this, value, replacer, space);
    work.stringifyCalls += 1;
    if (result !== undefined) { work.stringifiedBytes += Buffer.byteLength(result); }
    return result;
  };
  globalThis.structuredClone = function <T>(value: T, options?: Parameters<typeof originalStructuredClone>[1]): T {
    work.structuredClones += 1;
    return originalStructuredClone.call(this, value, options) as T;
  };
  try {
    return { result: await run(), stateBytes, work };
  } finally {
    JSON.parse = originalParse;
    JSON.stringify = originalStringify;
    globalThis.structuredClone = originalStructuredClone;
  }
}

function assertWorkBudget(operation: string, work, stateBytes: number, budget) {
  assert.ok(work.stateParses <= budget.stateParses,
    `${operation}: expected at most ${budget.stateParses} state parses, observed ${work.stateParses}`);
  assert.ok(work.stateParseBytes <= budget.parseBytes * stateBytes,
    `${operation}: expected at most ${budget.parseBytes}x state bytes parsed, observed ${work.stateParseBytes} / ${stateBytes}`);
  assert.ok(work.stringifyCalls <= budget.stringifyCalls,
    `${operation}: expected at most ${budget.stringifyCalls} JSON.stringify calls, observed ${work.stringifyCalls}`);
  assert.ok(work.stringifiedBytes <= budget.stringifyBytes * stateBytes,
    `${operation}: expected at most ${budget.stringifyBytes}x state bytes stringified, observed ${work.stringifiedBytes} / ${stateBytes}`);
  assert.ok(work.structuredClones <= budget.structuredClones,
    `${operation}: expected at most ${budget.structuredClones} structuredClone calls, observed ${work.structuredClones}`);
}

// Reads never materialize the canonical state: point queries return rows, so
// the parse budget is zero and clone budgets stay explicit per route.
const READ_BUDGETS = {
  status: { stateParses: 0, parseBytes: 0, stringifyCalls: 1, stringifyBytes: 1, structuredClones: 0 },
  context: { stateParses: 0, parseBytes: 0, stringifyCalls: 1, stringifyBytes: 1, structuredClones: 1 },
  history: { stateParses: 0, parseBytes: 0, stringifyCalls: 1, stringifyBytes: 1, structuredClones: 1 },
};

test("one mutation does not parse or serialize a full JSON state", async () => {
  const { mutate } = await importFresh("../src/kernel/mutate.ts");
  await withProject(async (projectDir) => {
    await writeCanonicalState(projectDir, {
      ...baseState(),
      plugins: { "budget.fixture": { data: "x".repeat(128 * 1024) } },
    });
    const measured = await measureStateWork(projectDir, () => mutate({
      projectDir,
      request: { action: "task.update", actor: "worker", input: {} },
      provider: updateProvider(),
    }));
    assert.equal(measured.work.stateParses, 0, "SQLite mutations must not parse a JSON state file");
    assert.equal(measured.work.stateParseBytes, 0);
    assert.equal((await readState(projectDir)).nodes.T1.title, "after");
  });
});

test("status, context, and history stay within state work budgets", async () => {
  const [status, context, history] = await Promise.all([
    importFresh("../src/cli/commands/status.ts"),
    importFresh("../src/cli/commands/context.ts"),
    importFresh("../src/cli/commands/history.ts"),
  ]);
  await withProject(async (projectDir) => {
    await writeCanonicalState(projectDir, {
      ...baseState(),
      plugins: { "budget.fixture": { data: "x".repeat(128 * 1024) } },
    });
    const routes = [
      ["status", () => status.default({ statePath: projectDir, flags: {} })],
      ["context", () => context.default({ statePath: projectDir, positional: ["T1"], flags: {} })],
      ["history", () => history.default({ statePath: projectDir, positional: ["T1"], flags: {} })],
    ] as const;
    for (const [name, run] of routes) {
      const measured = await measureStateWork(projectDir, run);
      assertWorkBudget(name, measured.work, measured.stateBytes, READ_BUDGETS[name]);
      assert.ok(measured.result, `${name}: expected a read result`);
    }
  });
});

