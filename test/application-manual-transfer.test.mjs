import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootstrapFencedState, readFencedState, replaceFencedStateUnderLock } from "../src/storage/ledger.ts";
import { createRemoteTransferBaselineStore } from "../src/storage/remote-transfer-baseline.ts";
import { withLock } from "../src/storage/lock.ts";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { pullManualTransfer, pushManualTransfer } from "../src/application/manual-transfer.ts";

function projectConfig(projectId) {
  return {
    project_id: projectId,
    backend: { type: "remote", url: "https://transfer.example.test/api/" },
  };
}

function payload(title = "remote") {
  return {
    version: 1,
    nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", title } },
    edges: [],
    initiatives: { demo: { desc: "demo" } },
    log: [],
  };
}

async function initialize(projectDir, state = payload("local")) {
  await bootstrapFencedState(projectDir);
  if (state) {
    await withLock(projectDir, (lockContext) => replaceFencedStateUnderLock(lockContext, {
      ...state,
      fence_generation: 1,
      revision: 0,
    }));
  }
}

async function fixture(t, { state = payload("local"), remoteRevision = 4, projectId, url } = {}) {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  await initialize(projectDir, state);
  const config = projectConfig(projectId || `transfer-${randomUUID()}`);
  if (url) {config.backend.url = url;}
  const remote = { payload: payload(), revision: remoteRevision };
  const calls = { exports: 0, imports: [] };
  const backendClient = {
    type: "remote",
    async exportTransfer() {
      calls.exports++;
      return { payload: remote.payload, revision: remote.revision };
    },
    async importTransfer(options) {
      calls.imports.push(options);
      remote.payload = options.payload;
      remote.revision++;
      return { revision: remote.revision, payload: "must not escape" };
    },
  };
  return { projectDir, config, remote, calls, backendClient, store: createRemoteTransferBaselineStore() };
}

async function changeLocalTitle(projectDir, title) {
  const current = await readFencedState(projectDir);
  current.nodes.T1.title = title;
  return withLock(projectDir, (lockContext) => replaceFencedStateUnderLock(lockContext, current));
}

function request(fixture, overrides = {}) {
  return {
    projectDir: fixture.projectDir,
    projectConfig: fixture.config,
    backendClient: fixture.backendClient,
    actor: "alice",
    force: false,
    ...overrides,
  };
}

test("first manual push imports the local snapshot and persists the confirmed baseline", async (t) => {
  const f = await fixture(t);

  const result = await pushManualTransfer(request(f));

  assert.deepEqual(Object.keys(result).sort(), ["forced", "local_revision", "project_id", "remote_revision", "transfer"]);
  assert.equal(result.transfer, "push");
  assert.equal(result.project_id, f.config.project_id);
  assert.equal(result.remote_revision, f.remote.revision);
  assert.equal(result.forced, false);
  assert.deepEqual(f.calls.imports[0], {
    payload: f.calls.imports[0].payload,
    actor: "alice",
  });
  assert.equal(f.calls.imports[0].payload.nodes.T1.title, "local");
  assert.deepEqual(await f.store.get("https://transfer.example.test", f.config.project_id), {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: result.remote_revision,
    local_revision: result.local_revision,
  });
  assert.equal(JSON.stringify(result).includes("must not escape"), false);
});

test("first manual pull installs the remote snapshot and persists the confirmed baseline", async (t) => {
  const f = await fixture(t, { state: null });

  const result = await pullManualTransfer(request(f));

  assert.deepEqual(Object.keys(result).sort(), ["forced", "local_revision", "project_id", "remote_revision", "transfer"]);
  assert.equal(result.transfer, "pull");
  assert.equal(result.project_id, f.config.project_id);
  assert.equal(result.remote_revision, f.remote.revision);
  assert.equal(result.forced, false);
  assert.equal(f.calls.exports, 1);
  assert.deepEqual(await f.store.get("https://transfer.example.test", f.config.project_id), {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision,
    local_revision: result.local_revision,
  });
});

test("manual pull then offline local work and push uses and advances the shared baseline", async (t) => {
  const f = await fixture(t, { state: null });

  const pulled = await pullManualTransfer(request(f));
  await changeLocalTitle(f.projectDir, "offline change");
  const pushed = await pushManualTransfer(request(f));

  assert.equal(f.calls.imports[0].expected_remote_revision, pulled.remote_revision);
  assert.equal(f.calls.imports[0].force, undefined);
  assert.equal(f.calls.imports[0].payload.nodes.T1.title, "offline change");
  assert.equal(pushed.local_revision, (await readFencedState(f.projectDir)).revision);
  assert.deepEqual(await f.store.get("https://transfer.example.test", f.config.project_id), {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: pushed.remote_revision,
    local_revision: pushed.local_revision,
  });
});

test("push uses the last confirmed remote revision for remote CAS and preserves structured conflicts", async (t) => {
  const f = await fixture(t);
  const previous = {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision - 1,
    local_revision: 0,
  };
  await f.store.set(previous);
  const remoteError = Object.assign(new Error("remote changed"), {
    code: "TRANSFER_REMOTE_CHANGED",
    status: 409,
    details: { expected: previous.remote_revision, current: f.remote.revision },
  });
  f.backendClient.importTransfer = async (options) => {
    f.calls.imports.push(options);
    throw remoteError;
  };

  await assert.rejects(pushManualTransfer(request(f)), (error) => {
    assert.equal(error, remoteError);
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { expected: previous.remote_revision, current: f.remote.revision });
    return true;
  });
  assert.equal(f.calls.imports[0].expected_remote_revision, previous.remote_revision);
  assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
});

test("force push omits expected remote revision and updates baseline only after confirmation", async (t) => {
  const f = await fixture(t);
  const previous = {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision - 1,
    local_revision: 0,
  };
  await f.store.set(previous);

  const result = await pushManualTransfer(request(f, { force: true }));

  assert.equal(Object.hasOwn(f.calls.imports[0], "expected_remote_revision"), false);
  assert.equal(f.calls.imports[0].force, true);
  assert.equal(result.forced, true);
  assert.deepEqual(await f.store.get(previous.origin, previous.project_id), {
    ...previous,
    remote_revision: result.remote_revision,
    local_revision: result.local_revision,
  });
});

test("force pull omits local CAS while replacing the destination and recording the new baseline", async (t) => {
  const f = await fixture(t);
  const before = await readFencedState(f.projectDir);
  await f.store.set({
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision,
    local_revision: before.revision - 1,
  });

  const result = await pullManualTransfer(request(f, { force: true }));

  assert.equal(result.forced, true);
  assert.equal((await readFencedState(f.projectDir)).nodes.T1.title, "remote");
  assert.deepEqual(await f.store.get("https://transfer.example.test", f.config.project_id), {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: result.remote_revision,
    local_revision: result.local_revision,
  });
});

test("pull maps stale local CAS to TRANSFER_LOCAL_CHANGED without advancing the baseline", async (t) => {
  const f = await fixture(t);
  const local = await readFencedState(f.projectDir);
  const previous = {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision - 1,
    local_revision: local.revision - 1,
  };
  await f.store.set(previous);

  await assert.rejects(pullManualTransfer(request(f)), (error) => {
    assert.equal(error.code, "TRANSFER_LOCAL_CHANGED");
    assert.equal(error.details.expected, previous.local_revision);
    assert.equal(error.details.current, local.revision);
    assert.match(error.message, /pull --force/);
    return true;
  });
  assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
});

test("pull maps a non-pristine destination without baseline to TRANSFER_BASE_UNKNOWN", async (t) => {
  const f = await fixture(t);

  await assert.rejects(pullManualTransfer(request(f)), (error) => {
    assert.equal(error.code, "TRANSFER_BASE_UNKNOWN");
    assert.match(error.message, /pull --force/);
    assert.match(error.details.force, /complete local DAG/);
    return true;
  });
  assert.equal(await f.store.get("https://transfer.example.test", f.config.project_id), null);
});

test("pull rejects a local write racing with the remote export", async (t) => {
  const f = await fixture(t);
  const local = await readFencedState(f.projectDir);
  const previous = {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision,
    local_revision: local.revision,
  };
  await f.store.set(previous);
  f.backendClient.exportTransfer = async () => {
    await changeLocalTitle(f.projectDir, "concurrent local write");
    return { payload: f.remote.payload, revision: f.remote.revision };
  };

  await assert.rejects(pullManualTransfer(request(f)), (error) => {
    assert.equal(error.code, "TRANSFER_LOCAL_CHANGED");
    assert.equal(error.details.expected, previous.local_revision);
    assert.ok(error.details.current > error.details.expected);
    return true;
  });
  assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
});

test("push timeout and network failures report ambiguous outcomes without advancing baseline", async (t) => {
  for (const code of ["REMOTE_TIMEOUT", "REMOTE_REQUEST_FAILED"]) {
    await t.test(code, async (t2) => {
      const f = await fixture(t2);
      const previous = {
        version: 1,
        origin: "https://transfer.example.test",
        project_id: f.config.project_id,
        remote_revision: f.remote.revision,
        local_revision: 0,
      };
      await f.store.set(previous);
      f.backendClient.importTransfer = async () => {
        throw Object.assign(new Error("network failure"), { code, details: { timeout_ms: 100 } });
      };

      await assert.rejects(pushManualTransfer(request(f)), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.details.timeout_ms, 100);
        assert.equal(error.details.remote_result_ambiguous, true);
        assert.match(error.message, /outcome is ambiguous/);
        return true;
      });
      assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
    });
  }
});

test("explicit remote HTTP and auth/protocol errors are preserved without fallback or ambiguity", async (t) => {
  for (const code of ["TRANSFER_REMOTE_CHANGED", "REMOTE_UNAUTHORIZED", "PROTOCOL_VERSION_UNSUPPORTED"]) {
    await t.test(code, async (t2) => {
      const f = await fixture(t2);
      const previous = {
        version: 1,
        origin: "https://transfer.example.test",
        project_id: f.config.project_id,
        remote_revision: f.remote.revision,
        local_revision: 0,
      };
      await f.store.set(previous);
      const remoteError = Object.assign(new Error("remote rejected request"), { code, status: 409, details: { current: 7 } });
      f.backendClient.importTransfer = async () => { throw remoteError; };

      await assert.rejects(pushManualTransfer(request(f)), (error) => {
        assert.equal(error, remoteError);
        assert.equal(error.code, code);
        assert.equal(error.details.remote_result_ambiguous, undefined);
        return true;
      });
      assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
    });
  }

  const f = await fixture(t);
  const previous = {
    version: 1,
    origin: "https://transfer.example.test",
    project_id: f.config.project_id,
    remote_revision: f.remote.revision,
    local_revision: (await readFencedState(f.projectDir)).revision,
  };
  await f.store.set(previous);
  const remoteError = Object.assign(new Error("authentication rejected"), { code: "REMOTE_UNAUTHORIZED", status: 401 });
  f.backendClient.exportTransfer = async () => { throw remoteError; };
  await assert.rejects(pullManualTransfer(request(f)), (error) => error === remoteError);
  assert.deepEqual(await f.store.get(previous.origin, previous.project_id), previous);
});

test("service rejects non-remote, incomplete and invalid transfer requests before I/O", async (t) => {
  const f = await fixture(t);
  const noCalls = {
    type: "remote",
    async exportTransfer() { throw new Error("must not call remote"); },
    async importTransfer() { throw new Error("must not call remote"); },
  };
  const invalidRequests = [
    request(f, { projectConfig: { ...f.config, backend: { type: "local" } }, backendClient: noCalls }),
    request(f, { projectConfig: { backend: f.config.backend }, backendClient: noCalls }),
    request(f, { projectConfig: { ...f.config, backend: { ...f.config.backend, protocol: "v1" } }, backendClient: noCalls }),
    request(f, { actor: " ", backendClient: noCalls }),
    request(f, { force: "true", backendClient: noCalls }),
    request(f, { backendClient: { type: "local" } }),
    request(f, { backendClient: { type: "remote", exportTransfer() {} } }),
  ];

  for (const invalid of invalidRequests) {
    await assert.rejects(pushManualTransfer(invalid));
    await assert.rejects(pullManualTransfer(invalid));
  }
});

test("baseline scopes use the configured origin and project id independently", async (t) => {
  const f = await fixture(t, { url: "https://transfer.example.test/api/v2" });
  const firstOrigin = "https://transfer.example.test";
  const secondOrigin = "https://other-transfer.example.test";
  const first = {
    version: 1,
    origin: firstOrigin,
    project_id: f.config.project_id,
    remote_revision: 2,
    local_revision: 3,
  };
  await f.store.set(first);
  f.config.backend.url = `${secondOrigin}/api`;

  const pushed = await pushManualTransfer(request(f));

  assert.deepEqual(await f.store.get(firstOrigin, f.config.project_id), first);
  assert.equal((await f.store.get(secondOrigin, f.config.project_id)).remote_revision, pushed.remote_revision);

  const otherProjectId = `${f.config.project_id}-other`;
  const otherProjectPush = await pushManualTransfer(request(f, {
    projectConfig: { ...f.config, project_id: otherProjectId },
  }));
  assert.equal(otherProjectPush.project_id, otherProjectId);
  assert.equal((await f.store.get(secondOrigin, otherProjectId)).remote_revision, otherProjectPush.remote_revision);
  assert.equal(await f.store.get(secondOrigin, f.config.project_id).then((entry) => entry.project_id), f.config.project_id);
});

test("confirmed transfer with a baseline write failure reports the changed side and revision", async (t) => {
  const previousHome = process.env.CLIMIER_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-manual-transfer-home-"));
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previousHome;}
    await fs.rm(home, { recursive: true, force: true });
  });
  const f = await fixture(t);
  f.backendClient.importTransfer = async () => {
    await fs.writeFile(path.join(home, "remote-transfer-baselines"), "occupied");
    return { revision: 23 };
  };

  await assert.rejects(pushManualTransfer(request(f)), (error) => {
    assert.equal(error.code, "REMOTE_TRANSFER_BASELINE_ERROR");
    assert.match(error.message, /remote DAG changed after confirmed push/);
    assert.match(error.message, /confirmed remote revision 23/);
    assert.equal(error.details.confirmed_remote_revision, 23);
    assert.ok(Number.isInteger(error.details.confirmed_local_revision));
    return true;
  });
});

test("confirmed pull with a baseline write failure reports the installed local revision", async (t) => {
  const previousHome = process.env.CLIMIER_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-manual-pull-home-"));
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previousHome;}
    await fs.rm(home, { recursive: true, force: true });
  });
  const f = await fixture(t, { state: null });
  f.backendClient.exportTransfer = async () => {
    await fs.writeFile(path.join(home, "remote-transfer-baselines"), "occupied");
    return { payload: f.remote.payload, revision: 23 };
  };

  await assert.rejects(pullManualTransfer(request(f)), (error) => {
    assert.equal(error.code, "REMOTE_TRANSFER_BASELINE_ERROR");
    assert.match(error.message, /local DAG changed after confirmed pull/);
    assert.match(error.message, /confirmed remote revision 23/);
    assert.ok(Number.isInteger(error.details.confirmed_local_revision));
    return true;
  });
});
