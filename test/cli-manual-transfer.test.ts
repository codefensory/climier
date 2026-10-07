import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRemoteTransferBaselineStore } from "../src/storage/remote-transfer-baseline.ts";
import { readFencedState } from "../src/storage/ledger.ts";
import { runCli as runCliCommand } from "../src/cli/dispatch.ts";
import { createTempProject, rmTempProject, writeCanonicalState } from "./helpers.ts";

const runCliInProcess = (options: unknown) => runCliCommand(options as Parameters<typeof runCliCommand>[0]);

type TransferRequest = {
  actor?: string;
  force?: boolean;
  expected_remote_revision?: number;
  payload: { nodes: Record<string, { title?: string }> };
};
type Fixture = {
  projectDir: string;
  config: { project_id: string; [key: string]: unknown };
  calls: { exports: number; imports: TransferRequest[] };
  backendClient: unknown;
};
type TransferResponse = {
  ok?: boolean;
  error: { code: string; message: string; details: Record<string, unknown> };
  [key: string]: unknown;
};

const remoteConfig = (projectId: string) => ({
  version: 1,
  project_id: projectId,
  backend: { type: "remote", url: "https://transfer.example.test/api/" },
});

const emptyState = () => ({ version: 1, initiatives: {}, nodes: {}, edges: [], log: [] });
const remotePayload = () => ({
  version: 1,
  initiatives: { demo: { desc: "demo" } },
  nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", title: "remote" } },
  edges: [],
  log: [],
});

async function fixture(t: { after(callback: () => void): void }, { state = emptyState(), client }: { state?: unknown; client?: unknown } = {}): Promise<Fixture> {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  const config = remoteConfig(`cli-transfer-${randomUUID()}`);
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify(config));
  await writeCanonicalState(projectDir, state);
  const calls: Fixture["calls"] = { exports: 0, imports: [] };
  const backendClient = client || {
    type: "remote",
    async exportTransfer() { calls.exports++; return { payload: remotePayload(), revision: 7 }; },
    async importTransfer(request) { calls.imports.push(request); return { revision: 8 }; },
  };
  return { projectDir, config, calls, backendClient };
}

async function invoke(f: Fixture, command: string, commandArgs: string[] = [], backendClient: unknown = f.backendClient, prefixArgs: string[] = []): Promise<{ result: number; exitCodes: number[]; data: TransferResponse; factoryOptions: { projectDir?: string; projectConfig?: unknown } | undefined }> {
  const output: string[] = [];
  const exitCodes: number[] = [];
  let factoryOptions;
  const result = await runCliInProcess({
    argv: [...prefixArgs, "--project", f.projectDir, command, ...commandArgs],
    createBackendClient(options) { factoryOptions = options; return backendClient; },
    write(value) { output.push(value); },
    exit(code) { exitCodes.push(code); },
  });
  return { result, exitCodes, data: JSON.parse(output[0]) as TransferResponse, factoryOptions };
}

test("push and pull are registered remote commands that return only the transfer summary", async (t) => {
  const pushFixture = await fixture(t, {
    state: {
      version: 1,
      initiatives: { demo: { desc: "demo" } },
      nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", title: "local" } },
      edges: [], log: [],
    },
  });
  const pushed = await invoke(pushFixture, "push", ["--as", "alice"]);
  assert.equal(pushed.result, 0);
  assert.ok(pushed.factoryOptions);
  assert.equal(pushed.factoryOptions.projectDir, pushFixture.projectDir);
  assert.deepEqual(pushed.factoryOptions.projectConfig, pushFixture.config);
  assert.deepEqual(pushed.data, {
    transfer: "push",
    project_id: pushFixture.config.project_id,
    remote_revision: 8,
    local_revision: pushed.data.local_revision,
    forced: false,
  });
  assert.deepEqual(Object.keys(pushed.data).sort(), ["forced", "local_revision", "project_id", "remote_revision", "transfer"]);
  const firstImport = pushFixture.calls.imports[0];
  assert.ok(firstImport);
  assert.equal(firstImport.actor, "alice");
  assert.equal(firstImport.payload.nodes.T1.title, "local");
  const forcedPush = await invoke(pushFixture, "push", ["--as", "alice", "--force"]);
  assert.equal(forcedPush.result, 0);
  const forcedImport = pushFixture.calls.imports[1];
  assert.ok(forcedImport);
  assert.equal(forcedImport.force, true);
  assert.equal(Object.hasOwn(forcedImport, "expected_remote_revision"), false);
  assert.equal(JSON.stringify(pushed.data).includes("payload"), false);
  assert.equal(JSON.stringify(pushed.data).includes("bearer"), false);

  const pullFixture = await fixture(t);
  const pulled = await invoke(pullFixture, "pull", ["--as", "bob", "--force"]);
  assert.equal(pulled.result, 0);
  assert.deepEqual(pulled.data, {
    transfer: "pull",
    project_id: pullFixture.config.project_id,
    remote_revision: 7,
    local_revision: pulled.data.local_revision,
    forced: true,
  });
  assert.equal(pullFixture.calls.exports, 1);
  const pulledState = await readFencedState(pullFixture.projectDir) as { nodes: Record<string, { title?: string }> };
  assert.equal(pulledState.nodes.T1.title, "remote");
});

test("push/pull require --as, reject positional arguments and require bare --force", async (t) => {
  for (const command of ["push", "pull"]) {
    const f = await fixture(t);
    for (const args of [["extra", "--as", "alice"], ["--force"], ["--as", "  "], ["--as", "alice", "--force=true"], ["--as", "alice", "--unknown"]]) {
      const response = await invoke(f, command, args);
      assert.equal(response.result, 2, `${command} ${args.join(" ")} should be a usage error`);
      assert.equal(response.data.ok, false);
      assert.equal(response.data.error.code, "CLI_USAGE_ERROR");
    }
    const beforeCommand = await invoke(f, command, ["--as", "alice"], f.backendClient, ["--force"]);
    assert.equal(beforeCommand.result, 2);
    assert.equal(beforeCommand.data.error.code, "CLI_USAGE_ERROR");
  }
});

test("manual transfer rejects local backend and keeps remote failures structured without fallback", async (t) => {
  const localFixture = await fixture(t);
  await fs.writeFile(path.join(localFixture.projectDir, ".climier.json"), JSON.stringify({
    version: 1,
    project_id: localFixture.config.project_id,
  }));
  const localClient = { type: "local" };
  const local = await invoke(localFixture, "push", ["--as", "alice"], localClient);
  assert.equal(local.result, 1);
  assert.equal(local.data.error.code, "REMOTE_BACKEND_REQUIRED");
  assert.equal(localFixture.calls.imports.length, 0);

  for (const [code, message, details] of [
    ["REMOTE_UNAUTHORIZED", "authentication failed", { status: 401 }],
    ["REMOTE_REQUEST_FAILED", "network unavailable", { cause: "offline" }],
    ["REMOTE_PROTOCOL_MISMATCH", "remote protocol mismatch", { expected: "v2" }],
  ] as Array<[string, string, Record<string, unknown>]>) {
    const remoteError = Object.assign(new Error(message), { code, details });
    const failingClient = {
      type: "remote",
      async exportTransfer() { return { payload: remotePayload(), revision: 7 }; },
      async importTransfer() { throw remoteError; },
    };
    const remoteFixture = await fixture(t, { client: failingClient });
    const failed = await invoke(remoteFixture, "push", ["--as", "alice"]);
    assert.equal(failed.result, 1);
    assert.equal(failed.data.error.code, code);
    assert.deepEqual(failed.data.error.details, code === "REMOTE_REQUEST_FAILED"
      ? { ...details, remote_result_ambiguous: true }
      : details);
    assert.match(failed.data.error.message, new RegExp(message));
  }
});

test("transfer conflicts retain codes/details and explain both force choices", async (t) => {
  const remoteConflict = Object.assign(new Error("remote revision changed"), {
    code: "TRANSFER_REMOTE_CHANGED",
    details: { expected: 4, current: 5 },
  });
  const pushFixture = await fixture(t, {
    client: {
      type: "remote",
      async exportTransfer() { return { payload: remotePayload(), revision: 7 }; },
      async importTransfer() { throw remoteConflict; },
    },
  });
  const pushed = await invoke(pushFixture, "push", ["--as", "alice"]);
  assert.equal(pushed.data.error.code, "TRANSFER_REMOTE_CHANGED");
  assert.deepEqual(pushed.data.error.details, { expected: 4, current: 5 });
  assert.match(pushed.data.error.message, /push --force/i);
  assert.match(pushed.data.error.message, /pull --force/i);

  const localFixture = await fixture(t, {
    state: {
      version: 1,
      initiatives: { demo: { desc: "demo" } },
      nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", title: "local" } },
      edges: [], log: [],
    },
  });
  const baselineStore = createRemoteTransferBaselineStore();
  const localState = await readFencedState(localFixture.projectDir) as { revision: number; nodes: Record<string, { title?: string }> };
  await baselineStore.set({
    version: 1,
    origin: "https://transfer.example.test",
    project_id: localFixture.config.project_id,
    remote_revision: 7,
    local_revision: localState.revision + 1,
  });
  const pulled = await invoke(localFixture, "pull", ["--as", "alice"]);
  assert.equal(pulled.data.error.code, "TRANSFER_LOCAL_CHANGED");
  assert.equal(pulled.data.error.details.expected, localState.revision + 1);
  assert.equal(pulled.data.error.details.current, localState.revision);
  assert.match(pulled.data.error.message, /push --force/i);
  assert.match(pulled.data.error.message, /pull --force/i);

  const baseUnknown = Object.assign(new Error("remote destination has no known base"), {
    code: "TRANSFER_BASE_UNKNOWN",
    details: { current: 9 },
  });
  const baseFixture = await fixture(t, {
    client: {
      type: "remote",
      async exportTransfer() { return { payload: remotePayload(), revision: 7 }; },
      async importTransfer() { throw baseUnknown; },
    },
  });
  const base = await invoke(baseFixture, "push", ["--as", "alice"]);
  assert.equal(base.data.error.code, "TRANSFER_BASE_UNKNOWN");
  assert.deepEqual(base.data.error.details, { current: 9 });
  assert.match(base.data.error.message, /push --force/i);
  assert.match(base.data.error.message, /pull --force/i);
});

test("invalid project metadata fails before creating a backend client", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.projectDir, ".climier.json"), JSON.stringify({
    version: 1,
    project_id: " ",
    backend: { type: "remote", protocol: "v2", url: "https://transfer.example.test" },
  }));
  const response = await invoke(f, "push", ["--as", "alice"]);
  assert.equal(response.result, 1);
  assert.equal(response.factoryOptions, undefined);
  assert.equal(response.data.ok, false);
});

test("help marks manual push/pull experimental and unsafe and warns about destructive force", async (t) => {
  const f = await fixture(t);
  const output: string[] = [];
  const codes: number[] = [];
  const result = await runCliInProcess({
    argv: ["--project", f.projectDir, "--help"],
    write(value) { output.push(value); },
    exit(code) { codes.push(code); },
  });
  assert.equal(result, 0);
  assert.deepEqual(codes, [0]);
  assert.match(output[0], /push.*EXPERIMENTAL.*UNSAFE/is);
  assert.match(output[0], /pull.*EXPERIMENTAL.*UNSAFE/is);
  assert.match(output[0], /force.*complete destination DAG/i);
  assert.match(output[0], /backup/i);
});

test("registered transfer commands advertise the current Remote v1 boundary", async (t) => {
  const f = await fixture(t);
  const output: string[] = [];
  const codes: number[] = [];
  const result = await runCliInProcess({
    argv: ["--project", f.projectDir, "--help"],
    write(value) { output.push(value); },
    exit(code) { codes.push(code); },
  });
  assert.equal(result, 0);
  assert.match(output[0], /login/);
  assert.match(output[0], /Remote v1/);
  assert.match(output[0], /\/v1/);
  assert.doesNotMatch(output[0], /CLIMIER_TOKEN|remote v2/);
});
