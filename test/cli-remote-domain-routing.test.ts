import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  readState,
  rmTempProject,
  writeCanonicalState,
} from "./helpers.mjs";
import addGateCommand from "../src/cli/commands/add-gate.ts";
import addKnowledgeCommand from "../src/cli/commands/add-knowledge.ts";
import addNodeCommand from "../src/cli/commands/add-node.ts";
import addInitiativeCommand from "../src/cli/commands/add-initiative.ts";
import addNoteCommand from "../src/cli/commands/add-note.ts";
import addEdgeCommand from "../src/cli/commands/add-edge.ts";
import removeEdgeCommand from "../src/cli/commands/remove-edge.ts";
import resolveCommand from "../src/cli/commands/resolve.ts";
import deprecateKnowledgeCommand from "../src/cli/commands/deprecate-knowledge.ts";
import updateCommand from "../src/cli/commands/update.ts";
import { bootstrapBuiltins, createBackendClient } from "../src/application/operations/index.ts";
import { mutate as kernelMutate } from "../src/kernel/mutate.ts";

const addGate = (value: unknown) => addGateCommand(value as Parameters<typeof addGateCommand>[0]);
const addKnowledge = (value: unknown) => addKnowledgeCommand(value as Parameters<typeof addKnowledgeCommand>[0]);
const addNode = (value: unknown) => addNodeCommand(value as Parameters<typeof addNodeCommand>[0]);
const addInitiative = (value: unknown) => addInitiativeCommand(value as Parameters<typeof addInitiativeCommand>[0]);
const addNote = (value: unknown) => addNoteCommand(value as Parameters<typeof addNoteCommand>[0]);
const addEdge = (value: unknown) => addEdgeCommand(value as Parameters<typeof addEdgeCommand>[0]);
const removeEdge = (value: unknown) => removeEdgeCommand(value as Parameters<typeof removeEdgeCommand>[0]);
const resolve = (value: unknown) => resolveCommand(value as Parameters<typeof resolveCommand>[0]);
const deprecateKnowledge = (value: unknown) => deprecateKnowledgeCommand(value as Parameters<typeof deprecateKnowledgeCommand>[0]);
const update = (value: unknown) => updateCommand(value as Parameters<typeof updateCommand>[0]);

const initialState = {
  version: 1,
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

function remoteOperationResult(args, node) {
  const results = {
    "edge.add": () => ({ edge: { from: args.input.from, to: args.input.to, type: args.input.type } }),
    "edge.remove": () => ({ removed: true }),
    "initiative.create": () => ({ desc: args.input.desc, created_at: "2026-09-25T00:00:00.000Z" }),
  };
  return results[args.operation]?.() || { node };
}

function createOperationDiff(args, id, node) {
  const createsEntity = args.operation.endsWith(".create") && args.operation !== "initiative.create";
  const updatesEntity = !args.operation.endsWith(".create") && args.operation !== "initiative.create";
  const created = createsEntity ? [{ id, node }] : [];
  const updated = updatesEntity ? [{ id, node }] : [];
  const initiative = { name: args.input.name, initiative: { desc: args.input.desc, created_at: "2026-09-25T00:00:00.000Z" } };
  return { created, updated, initiatives: { created: args.operation === "initiative.create" ? [initiative] : [] } };
}

function fakeRemoteBackend({ failure }: { failure?: Error } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    type: "remote",
    async readNode({ id }) {
      calls.push({ method: "readNode", id });
      return { node: initialState.nodes[id] };
    },
    async executeOperation(args) {
      calls.push(args);
      if (failure) { throw failure; }
      const id = args.input?.id || "created";
      const node = { ...initialState.nodes[id], ...args.input?.changes, id, revision: 13 };
      return {
        result: remoteOperationResult(args, node),
        diff: createOperationDiff(args, id, node),
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
    await writeCanonicalState(projectDir, initialState);
    const before = await readState(projectDir);
    await run(projectDir);
    assert.deepEqual(await readState(projectDir), before, "remote operation must not use local persistence");
  } finally {
    await rmTempProject(projectDir);
  }
}

test("local domain adapters delegate through the supplied application operation source", async () => {
  const projectDir = await createTempProject();
  const operations: string[] = [];
  const source = {
    registry: bootstrapBuiltins(),
    mutate(args) {
      operations.push(args.request.action);
      return kernelMutate(args);
    },
    selectPolicy: async () => null,
  };
  const backendClient = createBackendClient({ projectDir, source });
  try {
    await writeCanonicalState(projectDir, initialState);
    await addInitiative({ projectDir, statePath: projectDir, backendClient, source, positional: ["local-new"], flags: { as: "alice" } });
    await addNote({ projectDir, statePath: projectDir, backendClient, source, positional: ["G-existing", "local note"], flags: { as: "alice" } });
    await addEdge({ projectDir, statePath: projectDir, backendClient, source, positional: ["G-existing", "K-existing"], flags: { type: "DERIVED_FROM", as: "alice" } });
    await removeEdge({ projectDir, statePath: projectDir, backendClient, source, positional: ["G-existing", "K-existing"], flags: { type: "DERIVED_FROM", as: "alice" } });
    await deprecateKnowledge({ projectDir, statePath: projectDir, backendClient, source, positional: ["K-existing"], flags: { reason: "outdated", as: "alice" } });
    assert.deepEqual(operations, ["initiative.create", "note.add", "edge.add", "edge.remove", "knowledge.deprecate"]);
  } finally {
    await rmTempProject(projectDir);
  }
});

async function assertRemoteScenario(projectDir, scenario) {
  const { client, calls } = fakeRemoteBackend();
  const result = await scenario.run({ projectDir, statePath: projectDir, backendClient: client });
  assert.ok(Object.hasOwn(result, scenario.envelope), `${scenario.op} retains ${scenario.envelope} envelope`);
  assert.ok(calls.some((call) => call.operation === scenario.op), `${scenario.op} selects canonical operation`);
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
      await assertRemoteScenario(projectDir, scenario);
    }
  });
});

async function assertUpdateOperations(projectDir, updates) {
  for (const [id, operation] of updates) {
    const { client, calls } = fakeRemoteBackend();
    await update({ projectDir, statePath: projectDir, backendClient: client, positional: [id], flags: { title: "updated", as: "alice" } });
    assert.equal(calls.find((call) => call.operation)?.operation, operation);
  }
}

test("remote update selects the operation matching the target node kind", async () => {
  await withLocalSentinel((projectDir) => assertUpdateOperations(projectDir, [["T-existing", "task.update"], ["G-existing", "gate.update"], ["K-existing", "knowledge.update"]]));
});

async function assertInitiativeRemoteFailure(projectDir, offline) {
  const { client, calls } = fakeRemoteBackend({ failure: offline });
  const operation = addInitiative({ projectDir, statePath: projectDir, backendClient: client, positional: ["new-initiative"], flags: { as: "alice" } });
  await assert.rejects(operation, (error) => error === offline);
  assert.equal(calls.length, 1);
}

test("remote operation errors propagate and never fall back to local mutation", async () => {
  const offline = Object.assign(new Error("remote unavailable"), { code: "REMOTE_REQUEST_FAILED" });
  await withLocalSentinel((projectDir) => assertInitiativeRemoteFailure(projectDir, offline));
});
