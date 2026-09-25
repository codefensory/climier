import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import { createRemoteApiServer } from "../src/server/http.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { PUBLIC_CORE_OPS, PUBLIC_GATE_OPS, PUBLIC_KNOWLEDGE_OPS, PUBLIC_TASK_OPS } from "../src/application/operations/builtins.mjs";
import { HELP_TEXT } from "../src/cli/dispatch.mjs";
import { readState, rmTempProject, runCli, writeState } from "./helpers.mjs";

const builtInWrites = [
  "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
  "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel",
  "knowledge.create", "knowledge.update", "knowledge.deprecate",
  "initiative.create", "note.add", "edge.add", "edge.remove",
  "add-node/update task", "add-node/update gate", "add-node/update knowledge", "core.batch",
];

const localSentinel = {
  version: 4,
  revision: 21,
  initiatives: { local: { desc: "must remain local" } },
  nodes: {
    "T-local-sentinel": { id: "T-local-sentinel", kind: "resolvable", subkind: "task", title: "local sentinel", status: "open", revision: 3 },
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-write-sentinel" }],
};

async function withRemoteFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-write-e2e-"));
  const oldHome = process.env.CLIMIER_HOME;
  const home = path.join(root, "home");
  process.env.CLIMIER_HOME = home;
  const projectId = "write-e2e-project";
  const projectDir = path.join(root, "local-client");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({
    version: 1,
    project_id: projectId,
    backend: { type: "remote", url: "http://127.0.0.1:1" },
  }));
  await writeState(projectDir, localSentinel);

  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds: [projectId] });
  const [remoteDir] = await Promise.all([catalog.provisionProject(projectId)]);
  await initState({ projectDir: remoteDir });
  let opens = 0;
  const api = createRemoteApiServer({
    catalog,
    credentials: [{ token: "write-token", projectIds: [projectId] }],
    async openProject(projectDirForRequest) {
      opens += 1;
      return { projectDir: projectDirForRequest };
    },
  });
  await new Promise((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const configFile = path.join(projectDir, ".climier.json");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.backend.url = apiUrl;
  await fs.writeFile(configFile, JSON.stringify(config));
  const remoteEnv = {
    CLIMIER_HOME: home,
    CLIMIER_TOKEN: "write-token",
    CLIMIER_REMOTE_ORIGIN: apiUrl,
  };
  try {
    await run({ root, home, projectDir, projectId, remoteDir, api, apiUrl, remoteEnv, openCount: () => opens });
  } finally {
    await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    if (oldHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function cli(projectDir, command, args, env) {
  const result = await runCli(["--project", projectDir, command, ...args], { env });
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    assert.fail(`${command} output was not JSON (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
  }
  return { ...result, body };
}

async function preserveSentinel(projectDir, original) {
  assert.deepEqual(await readState(projectDir), original, "remote-selected writes must not persist local state");
}

async function changeBackendUrl(projectDir, url) {
  const file = path.join(projectDir, ".climier.json");
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  config.backend.url = url;
  await fs.writeFile(file, JSON.stringify(config));
}

function responseProtocolProxy(upstreamUrl) {
  return createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(`${upstreamUrl}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const headers = Object.fromEntries(upstream.headers);
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["x-climier-protocol-version"] = "999";
    response.writeHead(upstream.status, headers);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
}

test("real HTTP exercises every built-in write and preserves remote/local state boundaries", async () => {
  await withRemoteFixture(async ({ projectDir, remoteDir, projectId, apiUrl, remoteEnv }) => {
    const original = await readState(projectDir);
    const allWrites = [...PUBLIC_TASK_OPS, ...PUBLIC_GATE_OPS, ...PUBLIC_KNOWLEDGE_OPS, ...PUBLIC_CORE_OPS];
    assert.deepEqual([...allWrites].sort(), [
      "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
      "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel",
      "knowledge.create", "knowledge.update", "knowledge.deprecate", "initiative.create", "note.add", "edge.add", "edge.remove",
    ].sort(), "matrix matches the complete registered built-in write catalog");
    assert.equal(new Set(builtInWrites).size, builtInWrites.length, "matrix labels are unique");

    const created = [
      ["add-initiative", ["remote", "--desc", "remote initiative", "--as", "alice"], "initiative"],
      ["add-task", ["T-task", "--initiative", "remote", "--title", "task", "--body", "body", "--acceptance", "acceptance", "--blocked-by", "", "--as", "alice"], "task"],
      ["add-gate", ["G-main", "--initiative", "remote", "--title", "gate", "--body", "body", "--purpose", "decision", "--blocked-by", "", "--as", "alice"], "gate"],
      ["add-gate", ["G-cancel", "--initiative", "remote", "--title", "gate to cancel", "--body", "body", "--purpose", "approval", "--blocked-by", "", "--as", "alice"], "gate"],
      ["add-knowledge", ["K-main", "--initiative", "remote", "--title", "knowledge", "--body", "body", "--scope-tags", "remote", "--as", "alice"], "knowledge"],
      ["add-node", ["T-low", "--kind", "resolvable", "--subkind", "task", "--initiative", "remote", "--title", "low task", "--as", "alice"], "task"],
      ["add-node", ["G-low", "--kind", "resolvable", "--subkind", "gate", "--initiative", "remote", "--title", "low gate", "--as", "alice"], "gate"],
      ["add-node", ["K-low", "--kind", "knowledge", "--initiative", "remote", "--title", "low knowledge", "--as", "alice"], "knowledge"],
    ];
    for (const [command, args, kind] of created) {
      const result = await cli(projectDir, command, args, remoteEnv);
      assert.equal(result.code, 0, `${command}: ${JSON.stringify(result.body)}`);
      if (kind === "initiative") {
        assert.ok(result.body.initiative, `${command} keeps its initiative envelope`);
      } else {
        assert.ok(result.body.node, `${command} keeps its node envelope`);
        assert.equal(result.body.node.kind === "knowledge" ? "knowledge" : result.body.node.subkind, kind);
      }
      await preserveSentinel(projectDir, original);
    }

    const miscWrites = [
      ["add-note", ["T-task", "remote note", "--as", "alice"], "node"],
      ["add-edge", ["T-task", "T-low", "--type", "BLOCKS", "--as", "alice"], "edge"],
      ["update", ["T-low", "--title", "updated task", "--as", "alice"], "node"],
      ["update", ["G-low", "--title", "updated gate", "--as", "alice"], "node"],
      ["update", ["K-low", "--title", "updated knowledge", "--as", "alice"], "node"],
      ["update", ["G-main", "--title", "updated main gate", "--as", "alice"], "node"],
      ["resolve", ["G-main", "--choice", "approved", "--rationale", "ready", "--as", "alice"], "node"],
      ["update", ["K-main", "--title", "updated knowledge", "--as", "alice"], "node"],
      ["deprecate-knowledge", ["K-main", "--reason", "superseded", "--as", "alice"], "node"],
      ["remove-edge", ["T-task", "T-low", "--type", "BLOCKS", "--as", "alice"], "removed"],
    ];
    for (const [command, args, envelope] of miscWrites) {
      const result = await cli(projectDir, command, args, remoteEnv);
      assert.equal(result.code, 0, `${command}: ${JSON.stringify(result.body)}`);
      assert.ok(Object.hasOwn(result.body, envelope), `${command} keeps ${envelope} envelope`);
      await preserveSentinel(projectDir, original);
    }

    const lifecycle = [
      ["take", ["T-task", "--as", "alice"], "context", "in_progress"],
      ["release", ["T-task", "--as", "alice"], "node", "open"],
      ["take", ["T-task", "--as", "alice"], "context", "in_progress"],
      ["submit", ["T-task", "--note", "ready", "--as", "alice"], "node", "submitted"],
      ["reject", ["T-task", "--reason", "revise", "--as", "alice"], "node", "open"],
      ["take", ["T-task", "--as", "alice"], "context", "in_progress"],
      ["submit", ["T-task", "--note", "ready", "--as", "alice"], "node", "submitted"],
      ["accept", ["T-task", "--as", "alice"], "node", "done"],
      ["reopen", ["T-task", "--reason", "retry", "--as", "alice"], "node", "open"],
      ["take", ["T-task", "--as", "alice"], "context", "in_progress"],
      ["cancel", ["T-task", "--reason", "stop", "--as", "alice"], "node", "canceled"],
    ];
    for (const [command, args, envelope, status] of lifecycle) {
      const result = await cli(projectDir, command, args, remoteEnv);
      assert.equal(result.code, 0, `${command}: ${JSON.stringify(result.body)}`);
      const node = result.body.node || result.body.context?.node;
      assert.ok(result.body[envelope] || node, `${command} keeps ${envelope} envelope`);
      assert.equal(node?.status, status, `${command} returns the remote status`);
      await preserveSentinel(projectDir, original);
    }

    const batchInput = path.join(projectDir, "batch-input.json");
    await fs.writeFile(batchInput, JSON.stringify({ operations: [
      { op: "initiative.create", input: { name: "batch-initiative", desc: "created atomically" } },
      { op: "task.create", input: { id: "T-batched", initiative: "batch-initiative", title: "batched", body: "body", acceptance: "acceptance" } },
    ] }));
    const batch = await cli(projectDir, "batch", ["--file", batchInput, "--as", "alice"], remoteEnv);
    assert.equal(batch.code, 0, `core.batch: ${JSON.stringify(batch.body)}`);
    assert.ok(Array.isArray(batch.body.results), "batch returns canonical results envelope");
    await preserveSentinel(projectDir, original);

    const gateLifecycle = [
      ["reopen", "G-main", "retry", "open"],
      ["cancel", "G-cancel", "not needed", "canceled"],
    ];
    for (const [command, id, reason, status] of gateLifecycle) {
      const result = await cli(projectDir, command, [id, "--reason", reason, "--as", "alice"], remoteEnv);
      assert.equal(result.code, 0, `gate ${command}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.node?.status, status, `gate ${command} returns remote status`);
      await preserveSentinel(projectDir, original);
    }
    const remote = await readState(remoteDir);
    const remoteAfterGateReopen = remote;
    assert.equal(remote.nodes["G-main"].status, "open", "gate.reopen reaches remote state through the CLI adapter");
    assert.equal(remote.nodes["G-cancel"].status, "canceled", "gate.cancel reaches remote state through the CLI adapter");
    await preserveSentinel(projectDir, original);
    assert.equal(remoteAfterGateReopen.initiatives.remote.desc, "remote initiative");
    assert.ok(remote.nodes["G-main"], "gate.create with blocked_by: [] reaches remote state");
    assert.equal(remote.nodes["G-main"].blocked_by, undefined);
    assert.equal(remote.nodes["T-task"].status, "canceled");
    assert.equal(remote.nodes["T-task"].notes.at(-1).text, "remote note");
    assert.equal(remote.nodes["T-low"].title, "updated task");
    assert.equal(remote.nodes["G-low"].title, "updated gate");
    assert.equal(remote.nodes["K-low"].title, "updated knowledge");
    assert.equal(remote.nodes["K-main"].status, "deprecated");
    assert.equal(remoteAfterGateReopen.nodes["G-main"].status, "open");
    assert.equal(remoteAfterGateReopen.nodes["G-cancel"].status, "canceled");
    assert.equal(remote.edges.some((edge) => edge.from === "T-task" && edge.to === "T-low"), false);
    assert.equal(remote.nodes["T-batched"].title, "batched");
    assert.equal(remote.initiatives["batch-initiative"].desc, "created atomically");
    assert.equal(new URL(apiUrl).protocol, "http:");
    assert.equal(projectId, "write-e2e-project");
  });
});

test("remote auth, protocol, network, and remote operation rejection fail without local fallback", async () => {
  await withRemoteFixture(async ({ projectDir, remoteDir, api, apiUrl, remoteEnv, openCount }) => {
    const before = await readState(projectDir);
    const initialRemote = await readState(remoteDir);
    await cli(projectDir, "add-initiative", ["remote", "--desc", "registered", "--as", "alice"], remoteEnv);
    const unauthorized = await cli(projectDir, "add-initiative", ["unauthorized", "--as", "alice"], { ...remoteEnv, CLIMIER_TOKEN: "invalid-token" });
    assert.notEqual(unauthorized.code, 0);
    assert.equal(unauthorized.body.error.code, "AUTH_INVALID");
    await preserveSentinel(projectDir, before);

    const proxy = responseProtocolProxy(apiUrl);
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    await changeBackendUrl(projectDir, proxyUrl);
    const protocol = await cli(projectDir, "add-initiative", ["protocol-error", "--as", "alice"], { ...remoteEnv, CLIMIER_REMOTE_ORIGIN: proxyUrl });
    assert.notEqual(protocol.code, 0);
    assert.equal(protocol.body.error.code, "PROTOCOL_VERSION_UNSUPPORTED");
    await preserveSentinel(projectDir, before);
    await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));

    await changeBackendUrl(projectDir, apiUrl);
    const remoteBeforeRejection = await readState(remoteDir);
    const opensBeforeRejection = openCount();
    const rejected = await cli(projectDir, "add-task", ["T-rejected", "--initiative", "remote", "--title", "bad", "--body", "body", "--as", "alice"], remoteEnv);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.body.error.code, "MISSING_FIELD");
    assert.equal(openCount(), opensBeforeRejection, "local validation rejects before remote storage is opened");
    await preserveSentinel(projectDir, before);
    assert.notDeepEqual(remoteBeforeRejection, initialRemote, "valid setup mutation succeeded remotely");
    assert.deepEqual(await readState(remoteDir), remoteBeforeRejection, "rejected remote write has no remote side effect");

    await changeBackendUrl(projectDir, "http://127.0.0.1:1");
    const unavailable = await cli(projectDir, "add-initiative", ["network-error", "--as", "alice"], { ...remoteEnv, CLIMIER_REMOTE_ORIGIN: "http://127.0.0.1:1" });
    assert.notEqual(unavailable.code, 0);
    assert.equal(unavailable.body.error.code, "REMOTE_REQUEST_FAILED");
    await preserveSentinel(projectDir, before);
    assert.equal(api.listening, true);
  });
});

test("remote unsupported commands reject before opening remote storage", async () => {
  await withRemoteFixture(async ({ projectDir, remoteEnv, openCount }) => {
    const original = await readState(projectDir);
    const opens = openCount();
    for (const [command, args] of [["snapshots", []], ["restore", ["snapshot", "--as", "alice"]], ["ui", []], ["plugin-not-installed", ["run"]]]) {
      const result = await cli(projectDir, command, args, remoteEnv);
      assert.notEqual(result.code, 0, `${command} must not be offered by the remote backend`);
      assert.equal(result.body.error.code, "REMOTE_UNSUPPORTED_OPERATION");
      assert.equal(result.body.error.details.command, command);
      assert.equal(openCount(), opens, `${command} must reject before opening remote state`);
      await preserveSentinel(projectDir, original);
    }
  });
});

test("write matrix includes each public operation and documented remote commands", () => {
  assert.deepEqual(builtInWrites, [
    "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
    "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel",
    "knowledge.create", "knowledge.update", "knowledge.deprecate", "initiative.create", "note.add", "edge.add", "edge.remove",
    "add-node/update task", "add-node/update gate", "add-node/update knowledge", "core.batch",
  ]);
  for (const command of ["take", "release", "reopen", "cancel", "submit", "accept", "reject", "resolve", "deprecate-knowledge", "remove-edge", "batch"]) {
    assert.match(HELP_TEXT, new RegExp(`\\b${command}\\b`));
  }
});
