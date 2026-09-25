import test from "node:test";
import assert from "node:assert/strict";

import status from "../src/cli/commands/status.mjs";
import context from "../src/cli/commands/context.mjs";
import show from "../src/cli/commands/show.mjs";
import history from "../src/cli/commands/history.mjs";
import search from "../src/cli/commands/search.mjs";
import initiatives from "../src/cli/commands/initiatives.mjs";
import log from "../src/cli/commands/log.mjs";
import state from "../src/cli/commands/state.mjs";
import { createTempProject, rmTempProject, writeState, readState } from "./helpers.mjs";

const sentinelState = {
  version: 4,
  revision: 9,
  initiatives: { local: { desc: "local sentinel" } },
  nodes: {
    "T-local": {
      id: "T-local",
      kind: "resolvable",
      subkind: "task",
      title: "Local sentinel must not be returned",
      status: "open",
    },
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-log", task: "T-local" }],
};

const remoteResponses = {
  status: { summary: { ready: 0 }, tasks: { ready: [{ id: "T-remote" }] } },
  context: { node: { id: "T-remote" }, derived_status: "ready" },
  show: { type: "task", node: { id: "T-remote" } },
  history: { id: "T-remote", entries: [{ id: "remote-history" }] },
  search: { matches: [{ id: "K-remote" }], count: 1 },
  initiatives: { initiatives: [{ name: "remote" }], unregistered: { nodes: 0, values: [] }, all: true },
  log: [{ id: "remote-log" }],
  state: { revision: 42, nodes: { "T-remote": {} }, edges: [], derived: {}, plugins: {} },
};

function commandCases(client, statePath = "/not/read/locally") {
  return [
    {
      name: "status",
      expected: remoteResponses.status,
      run: () => status({
        statePath,
        backendClient: client,
        positional: [],
        flags: {
          initiative: "remote-init",
          kind: "task",
          status: "ready",
          domain: "api",
          "claimed-by": "alice",
          "stale-ms": "0",
          limit: "2",
          all: true,
          as: "alice",
        },
      }),
      options: {
        initiative: "remote-init",
        kind: "task",
        status: "ready",
        domain: "api",
        claimedBy: "alice",
        staleMs: 0,
        limit: 2,
        all: true,
        as: "alice",
      },
      method: "readStatus",
    },
    {
      name: "context",
      expected: remoteResponses.context,
      run: () => context({
        statePath,
        backendClient: client,
        positional: ["T-remote"],
        flags: { as: "alice", staleMs: "0" },
      }),
      options: { id: "T-remote", as: "alice", staleMs: 0 },
      method: "readContext",
    },
    {
      name: "show",
      expected: remoteResponses.show,
      run: () => show({
        statePath,
        backendClient: client,
        positional: ["T-remote"],
        flags: {},
      }),
      options: { id: "T-remote" },
      method: "readNode",
    },
    {
      name: "history",
      expected: remoteResponses.history,
      run: () => history({
        statePath,
        backendClient: client,
        positional: ["T-remote"],
        flags: { limit: "2" },
      }),
      options: { id: "T-remote", limit: 2 },
      method: "readHistory",
    },
    {
      name: "search",
      expected: remoteResponses.search,
      run: () => search({
        statePath,
        backendClient: client,
        positional: ["Remote Needle"],
        flags: { all: true },
      }),
      options: { query: "remote needle", all: true },
      method: "readSearch",
    },
    {
      name: "initiatives",
      expected: remoteResponses.initiatives,
      run: () => initiatives({
        statePath,
        backendClient: client,
        positional: [],
        flags: { all: true },
      }),
      options: { all: true },
      method: "readInitiatives",
    },
    {
      name: "log",
      expected: remoteResponses.log,
      run: () => log({
        statePath,
        backendClient: client,
        positional: [],
        flags: { limit: "2", action: "task.create", agent: "alice", task: "T-remote", decision: "D-remote" },
      }),
      options: { limit: 2, action: "task.create", agent: "alice", task: "T-remote", decision: "D-remote" },
      method: "readLog",
    },
    {
      name: "state",
      expected: remoteResponses.state,
      run: () => state({ statePath, backendClient: client }),
      options: undefined,
      method: "readState",
    },
  ];
}

function createRemoteClient({ rejectWith } = {}) {
  const calls = [];
  const client = { type: "remote" };
  for (const [method, response] of Object.entries({
    readStatus: remoteResponses.status,
    readContext: remoteResponses.context,
    readNode: remoteResponses.show,
    readHistory: remoteResponses.history,
    readSearch: remoteResponses.search,
    readInitiatives: remoteResponses.initiatives,
    readLog: remoteResponses.log,
    readState: remoteResponses.state,
  })) {
    client[method] = (options) => {
      calls.push({ method, options });
      return rejectWith ? Promise.reject(rejectWith) : Promise.resolve(response);
    };
  }
  return { client, calls };
}

test("remote CLI reads use their typed backend methods and preserve local state", async () => {
  const projectDir = await createTempProject();
  try {
    await writeState(projectDir, sentinelState);
    const before = await readState(projectDir);
    const { client, calls } = createRemoteClient();
    const commands = commandCases(client, projectDir);

    for (const command of commands) {
      assert.deepEqual(await command.run(), command.expected, `${command.name} must return the remote result`);
    }
    assert.deepEqual(calls, commands.map(({ method, options }) => ({ method, options })));
    assert.deepEqual(await readState(projectDir), before);
  } finally {
    await rmTempProject(projectDir);
  }
});

test("remote CLI read failures propagate without returning or changing the local sentinel", async () => {
  const projectDir = await createTempProject();
  const errors = [
    Object.assign(new Error("remote timed out"), { code: "REMOTE_TIMEOUT" }),
    Object.assign(new Error("authentication required"), { code: "AUTH_REQUIRED", status: 401 }),
  ];
  try {
    await writeState(projectDir, sentinelState);
    const before = await readState(projectDir);

    for (const remoteError of errors) {
      const { client, calls } = createRemoteClient({ rejectWith: remoteError });
      for (const command of commandCases(client, projectDir)) {
        await assert.rejects(command.run(), (error) => error === remoteError, `${command.name} must propagate ${remoteError.code}`);
      }
      assert.equal(calls.length, 8);
    }

    assert.deepEqual(await readState(projectDir), before);
  } finally {
    await rmTempProject(projectDir);
  }
});

test("remote search routes an empty query to the selected backend", async () => {
  const { client, calls } = createRemoteClient();
  const result = await search({ statePath: "/not/read/locally", backendClient: client, positional: [""], flags: {} });
  assert.deepEqual(result, remoteResponses.search);
  assert.deepEqual(calls, [{ method: "readSearch", options: { query: "", all: false } }]);
});
