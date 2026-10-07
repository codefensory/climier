import { createTempProject, importFresh, writeFencedState, readState as readRawState } from "../../helpers.ts";

function baseNodes() {
  return {
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
    G1: {
      id: "G1",
      kind: "resolvable",
      subkind: "gate",
      title: "Auth strategy",
      initiative: "p",
      status: "open",
      revision: 1,
      purpose: "decision",
    },
  };
}

export function baseState() {
  return {
    version: 5,
    revision: 0,
    nodes: baseNodes(),
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { p: { desc: "plugin platform", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

export async function seedState(dir, mutate) {
  const base = baseState();
  if (typeof mutate === "function") {
    mutate(base);
  }
  try {
    const current = await readRawState(dir);
    base.revision = current.revision;
    base.fence_generation = current.fence_generation;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    base.revision = 0;
    delete base.fence_generation;
  }
  return writeFencedState(dir, base);
}

export async function freshApi(dir, opts = {}) {
  const { createApi } = await importFresh("./plugins/api.ts");
  return createApi({
    projectDir: dir,
    agent: opts.agent === undefined ? "tester" : opts.agent,
    pluginId: opts.pluginId || "example.audit",
  });
}

export async function readyProject() {
  const dir = await createTempProject();
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
  await addInit({
    statePath: dir,
    flags: { desc: "plugin platform" },
    positional: ["plugin-platform"],
  });
  return dir;
}
