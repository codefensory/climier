import test from "node:test";
import assert from "node:assert/strict";

import status from "../src/cli/commands/status.ts";
import context from "../src/cli/commands/context.ts";
import show from "../src/cli/commands/show.ts";
import history from "../src/cli/commands/history.ts";
import search from "../src/cli/commands/search.ts";
import initiatives from "../src/cli/commands/initiatives.ts";
import log from "../src/cli/commands/log.ts";
import state from "../src/cli/commands/state.ts";
import { createTempProject, rmTempProject, writeCanonicalState, readState, runCli, initExampleProject } from "./helpers.mjs";

const sentinelState = {
  version: 1,
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

function commandCase({ name, run, options, method, statePath, expected }) {
  return { name, expected, run, options, method, statePath };
}

function commandCases(client, statePath = "/not/read/locally") {
  const id = "T-remote";
  return [
    commandCase({ name: "status", expected: remoteResponses.status, method: "readStatus", statePath,
      options: { initiative: "remote-init", kind: "task", status: "ready", domain: "api", claimedBy: "alice", staleMs: 0, limit: 2, all: true, as: "alice" },
      run: () => status({ statePath, backendClient: client, positional: [], flags: { initiative: "remote-init", kind: "task", status: "ready", domain: "api", "claimed-by": "alice", "stale-ms": "0", limit: "2", all: true, as: "alice" } }) }),
    commandCase({ name: "context", expected: remoteResponses.context, method: "readContext", statePath,
      options: { id, as: "alice", staleMs: 0 }, run: () => context({ statePath, backendClient: client, positional: [id], flags: { as: "alice", staleMs: "0" } }) }),
    commandCase({ name: "show", expected: remoteResponses.show, method: "readNode", statePath,
      options: { id }, run: () => show({ statePath, backendClient: client, positional: [id], flags: {} }) }),
    commandCase({ name: "history", expected: remoteResponses.history, method: "readHistory", statePath,
      options: { id, limit: 2 }, run: () => history({ statePath, backendClient: client, positional: [id], flags: { limit: "2" } }) }),
    commandCase({ name: "search", expected: remoteResponses.search, method: "readSearch", statePath,
      options: { query: "remote needle", all: true }, run: () => search({ statePath, backendClient: client, positional: ["Remote Needle"], flags: { all: true } }) }),
    commandCase({ name: "initiatives", expected: remoteResponses.initiatives, method: "readInitiatives", statePath,
      options: { all: true }, run: () => initiatives({ statePath, backendClient: client, positional: [], flags: { all: true } }) }),
    commandCase({ name: "log", expected: remoteResponses.log, method: "readLog", statePath,
      options: { limit: 2, action: "task.create", agent: "alice", node: id },
      run: () => log({ statePath, backendClient: client, positional: [], flags: { limit: "2", action: "task.create", agent: "alice", node: id } }) }),
    commandCase({ name: "state", expected: remoteResponses.state, method: "readState", statePath,
      options: undefined, run: () => state({ statePath, backendClient: client }) }),
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
    await writeCanonicalState(projectDir, sentinelState);
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
    await writeCanonicalState(projectDir, sentinelState);
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

test("CLI: context on a ready task reports derived_status=ready and no blocking", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "context", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "F0.T1");
    assert.equal(data.derived_status, "ready");
    assert.equal(data.can_claim, true);
    assert.equal(data.blocking.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});
