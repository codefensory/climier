import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  readState,
  rmTempProject,
  writeState,
} from "./helpers.mjs";
import addGate from "../src/cli/commands/add-gate.mjs";
import addKnowledge from "../src/cli/commands/add-knowledge.mjs";
import addNode from "../src/cli/commands/add-node.mjs";
import addInitiative from "../src/cli/commands/add-initiative.mjs";
import addNote from "../src/cli/commands/add-note.mjs";
import addEdge from "../src/cli/commands/add-edge.mjs";
import removeEdge from "../src/cli/commands/remove-edge.mjs";
import resolve from "../src/cli/commands/resolve.mjs";
import deprecateKnowledge from "../src/cli/commands/deprecate-knowledge.mjs";
import update from "../src/cli/commands/update.mjs";

const initialState = {
  version: 4,
  revision: 12,
  initiatives: { remote: { desc: "fixture" } },
  nodes: {
    "G-existing": { id: "G-existing", kind: "resolvable", subkind: "gate", title: "gate", status: "open", revision: 7, resolution_mode: "choice" },
    "K-existing": { id: "K-existing", kind: "knowledge", title: "knowledge", status: "active", revision: 8, scope: { domains: ["cli"], initiatives: [], tags: [], node_ids: [] } },
    "T-existing": { id: "T-existing", kind: "resolvable", subkind: "task", title: "task", status: "open", revision: 6 },
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-sentinel" }],
};

function fakeRemoteBackend({ failure } = {}) {
  const calls = [];
  const client = {
    type: "remote",
    async readNode({ id }) {
      calls.push({ method: "readNode", id });
      return { node: initialState.nodes[id] };
    },
    async executeOperation(args) {
      calls.push(args);
      if (failure) throw failure;
      const id = args.input?.id || "created";
      const node = { ...(initialState.nodes[id] || {}), ...(args.input?.changes || {}), id, revision: 13 };
      return {
        result: args.operation === "edge.add"
          ? { edge: { from: args.input.from, to: args.input.to, type: args.input.type } }
          : args.operation === "edge.remove"
            ? { removed: true }
            : args.operation === "initiative.create"
              ? { desc: args.input.desc, created_at: "2026-09-25T00:00:00.000Z" }
              : { node },
        diff: {
          created: args.operation.endsWith(".create") && args.operation !== "initiative.create" ? [{ id, node }] : [],
          updated: args.operation.endsWith(".create") || args.operation === "initiative.create" ? [] : [{ id, node }],
          initiatives: { created: args.operation === "initiative.create" ? [{ name: args.input.name, initiative: { desc: args.input.desc, created_at: "2026-09-25T00:00:00.000Z" } }] : [] },
        },
        effects: { newly_ready: ["T-next"] },
      };
    },
    async executeBatch() { throw new Error("unexpected batch request"); },
  };
  return { client, calls };
}

async function withLocalSentinel(run) {
  const projectDir = await createTempProject();
  try {
    await writeState(projectDir, initialState);
    const before = await readState(projectDir);
    await run(projectDir);
    assert.deepEqual(await readState(projectDir), before, "remote operation must not use local persistence");
  } finally {
    await rmTempProject(projectDir);
  }
}

test("remaining domain adapters use canonical remote operations and retain CLI envelopes", async () => {
  await withLocalSentinel(async (projectDir) => {
    const scenarios = [
      { op: "gate.create", envelope: "node", run: (ctx) => addGate({ ...ctx, positional: ["G-new"], flags: { initiative: "remote", title: "gate", body: "body", purpose: "decision", as: "alice" } }) },
      { op: "knowledge.create", envelope: "node", run: (ctx) => addKnowledge({ ...ctx, positional: ["K-new"], flags: { initiative: "remote", title: "knowledge", body: "body", "scope-domains": "cli", as: "alice" } }) },
      { op: "gate.create", envelope: "node", run: (ctx) => addNode({ ...ctx, positional: ["G-low"], flags: { kind: "resolvable", subkind: "gate", title: "gate", initiative: "remote", as: "alice" } }) },
      { op: "task.create", envelope: "node", run: (ctx) => addNode({ ...ctx, positional: ["T-low"], flags: { kind: "resolvable", subkind: "task", title: "task", initiative: "remote", as: "alice" } }) },
      { op: "knowledge.create", envelope: "node", run: (ctx) => addNode({ ...ctx, positional: ["K-low"], flags: { kind: "knowledge", title: "knowledge", initiative: "remote", "scope-tags": "cli", as: "alice" } }) },
      { op: "initiative.create", envelope: "initiative", run: (ctx) => addInitiative({ ...ctx, positional: ["new-initiative"], flags: { desc: "desc", as: "alice" } }) },
      { op: "note.add", envelope: "node", run: (ctx) => addNote({ ...ctx, positional: ["G-existing", "note text"], flags: { as: "alice" } }) },
      { op: "edge.add", envelope: "edge", run: (ctx) => addEdge({ ...ctx, positional: ["G-existing", "K-existing"], flags: { type: "DERIVED_FROM", as: "alice" } }) },
      { op: "edge.remove", envelope: "removed", run: (ctx) => removeEdge({ ...ctx, positional: ["G-existing", "K-existing"], flags: { type: "DERIVED_FROM", as: "alice" } }) },
      { op: "gate.resolve", envelope: "newly_ready", run: (ctx) => resolve({ ...ctx, positional: ["G-existing"], flags: { choice: "yes", rationale: "because", as: "alice" } }) },
      { op: "knowledge.deprecate", envelope: "node", run: (ctx) => deprecateKnowledge({ ...ctx, positional: ["K-existing"], flags: { reason: "outdated", as: "alice" } }) },
    ];

    for (const scenario of scenarios) {
      const { client, calls } = fakeRemoteBackend();
      const result = await scenario.run({ projectDir, statePath: projectDir, backendClient: client });
      assert.ok(Object.hasOwn(result, scenario.envelope), `${scenario.op} retains ${scenario.envelope} envelope`);
      assert.ok(calls.some((call) => call.operation === scenario.op), `${scenario.op} selects canonical operation`);
    }
  });
});

test("remote update selects the operation matching the target node kind", async () => {
  await withLocalSentinel(async (projectDir) => {
    for (const [id, operation] of [["T-existing", "task.update"], ["G-existing", "gate.update"], ["K-existing", "knowledge.update"]]) {
      const { client, calls } = fakeRemoteBackend();
      await update({ projectDir, statePath: projectDir, backendClient: client, positional: [id], flags: { title: "updated", as: "alice" } });
      assert.equal(calls.find((call) => call.operation)?.operation, operation);
    }
  });
});

test("remote operation errors propagate and never fall back to local mutation", async () => {
  await withLocalSentinel(async (projectDir) => {
    const offline = Object.assign(new Error("remote unavailable"), { code: "REMOTE_REQUEST_FAILED" });
    const { client, calls } = fakeRemoteBackend({ failure: offline });
    await assert.rejects(
      () => addInitiative({ projectDir, statePath: projectDir, backendClient: client, positional: ["new-initiative"], flags: { as: "alice" } }),
      (error) => error === offline,
    );
    assert.equal(calls.length, 1);
  });
});
