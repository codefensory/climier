// Shared fixtures for the plugin compatibility contract suites.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  stateFilePath,
  runCli,
  writeState,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
  writeCanonicalState,
} from "./helpers.mjs";

export {
  createTempProject,
  rmTempProject,
  importFresh,
  stateFilePath,
  runCli,
  writeState,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
  writeCanonicalState,
};

export async function submitAcceptTask(dir, id = "T1", as = "tester", note = "done") {
  const { default: submit } = await importFresh("./cli/commands/submit.mjs");
  const { default: accept } = await importFresh("./cli/commands/accept.mjs");
  await submit({ statePath: dir, projectDir: dir, positional: [id], flags: { as, note } });
  return accept({ statePath: dir, projectDir: dir, positional: [id], flags: { as } });
}

export function snapshotDir(dir) {
  return path.join(path.dirname(stateFilePath(dir)), "snapshots");
}

export function baseState() {
  return {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "T1",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
      T2: {
        id: "T2",
        kind: "resolvable",
        subkind: "task",
        title: "T2",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
    },
    edges: [],
    initiatives: { p: { desc: "plugin platform", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

// Seed distinct values so preservation regressions are visible.
export function seedPluginData(state) {
  state.plugins = {
    "example.audit": {
      data: { counter: 7, label: "audit run #7", nested: { ok: true } },
    },
    "example.metrics": {
      data: { count: 42 },
    },
  };
  if (state.nodes && state.nodes.T1) {
    state.nodes.T1.plugins = {
      "example.audit": { data: { perNode: "T1 audit" } },
    };
  }
  if (state.nodes && state.nodes.T2) {
    state.nodes.T2.plugins = {
      "example.audit": { data: { perNode: "T2 audit" } },
      "example.metrics": { data: { perNode: "T2 metrics" } },
    };
  }
}

export async function bootstrapState(dir, mutate) {
  const base = baseState();
  if (typeof mutate === "function") {
    mutate(base);
  }
  await writeState(dir, base);
  return base;
}

export function assertPluginDataPreserved(state) {
  assert.ok(state.plugins, "root `plugins` must be preserved");
  assert.deepEqual(state.plugins["example.audit"].data, {
    counter: 7,
    label: "audit run #7",
    nested: { ok: true },
  });
  assert.deepEqual(state.plugins["example.metrics"].data, { count: 42 });
  if (state.nodes && state.nodes.T1) {
    assert.ok(state.nodes.T1.plugins, "T1.plugins must be preserved");
    assert.deepEqual(state.nodes.T1.plugins["example.audit"].data, { perNode: "T1 audit" });
  }
  if (state.nodes && state.nodes.T2) {
    assert.ok(state.nodes.T2.plugins, "T2.plugins must be preserved");
    assert.deepEqual(state.nodes.T2.plugins["example.audit"].data, { perNode: "T2 audit" });
    assert.deepEqual(state.nodes.T2.plugins["example.metrics"].data, { perNode: "T2 metrics" });
  }
}

export async function fsp_writeFile(filePath, contents) {
  await fs.writeFile(filePath, contents);
}
