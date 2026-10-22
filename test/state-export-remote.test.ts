import test from "node:test";
import assert from "node:assert/strict";

import stateCommand from "../src/cli/commands/state.ts";
import { createTempProject, rmTempProject, writeCanonicalState } from "./helpers.ts";

const canonical = {
  version: 1,
  revision: 7,
  initiatives: { core: { desc: "Export fixture", created_at: "2026-10-21T00:00:00.000Z" } },
  nodes: { "T-export": { id: "T-export", kind: "resolvable", subkind: "task", title: "Export", status: "open" } },
  edges: [],
  plugins: { "plugin.test": { enabled: true } },
  log: [{ action: "task.create", node: "T-export" }],
};

function context(projectDir: string, positional: string[], backendClient?: unknown) {
  return {
    command: "state",
    originalArgv: [],
    flags: {},
    positional,
    projectDir,
    statePath: projectDir,
    projectConfig: {},
    backendClient: backendClient as never,
  };
}

test("state export from a remote backend matches the complete local schema-1 export", async () => {
  const projectDir = await createTempProject();
  try {
    const state = await writeCanonicalState(projectDir, canonical);
    const local = await stateCommand(context(projectDir, ["export"]));
    let reads = 0;
    const remote = await stateCommand(context(projectDir, ["export"], {
      type: "remote",
      readState: async () => { reads += 1; return structuredClone(state); },
    }));

    assert.equal(reads, 1);
    assert.equal(JSON.stringify(remote), JSON.stringify(local));
    assert.equal(JSON.stringify(remote), JSON.stringify(state));
  } finally {
    await rmTempProject(projectDir);
  }
});

test("state export rejects a remote state projection instead of exporting it", async () => {
  const projectDir = await createTempProject();
  try {
    await assert.rejects(
      stateCommand(context(projectDir, ["export"], {
        type: "remote",
        readState: async () => ({ revision: 7, nodes: {}, edges: [], derived: {}, plugins: {} }),
      })),
      /state export: remote backend did not return canonical schema-1 state/,
    );
  } finally {
    await rmTempProject(projectDir);
  }
});

test("remote state remains the same read-model projection", async () => {
  const projectDir = await createTempProject();
  try {
    const { projectSnapshot } = await import("../src/read-model/index.ts");
    const state = await writeCanonicalState(projectDir, canonical);
    const projection = await stateCommand(context(projectDir, [], {
      type: "remote",
      readState: async () => structuredClone(state),
    }));
    assert.deepEqual(projection, projectSnapshot({ snapshot: state as never }));
  } finally {
    await rmTempProject(projectDir);
  }
});
