import { createTempProject, importFresh, writeFencedState, readState as readRawState } from "../../helpers.ts";
import type { PluginApi } from "../../../src/plugins/types.ts";

type FixtureNode = Record<string, unknown> & { id: string };
type FixtureState = {
  version: number;
  revision: number;
  fence_generation?: number;
  nodes: Record<string, FixtureNode>;
  edges: Array<{ from: string; to: string; type: string }>;
  initiatives: Record<string, { desc: string; created_at?: string }>;
  log: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
type SeedMutator = (state: FixtureState) => void;
type ApiOptions = { agent?: string; pluginId?: string };
type ApiLog = { action: string; node: string; plugin_id: string; agent: string };
type ApiNode = {
  [key: string]: unknown;
  id: string;
  title: string;
  status: string;
  revision: number;
};
type ApiDiff = {
  created: Array<{ id: string; node: ApiNode }>;
  updated: Array<{ id: string; node: ApiNode }>;
};
type ApiTasks = {
  ready: ApiNode[];
  blocked: ApiNode[];
  submitted: ApiNode[];
  in_progress: ApiNode[];
};
type ApiObject = {
  [key: string]: unknown;
  id: string;
  name: string;
  title: string;
  status: string;
  revision: number;
  derived_status: string;
  result: ApiObject;
  diff: ApiDiff;
  node: ApiNode;
  log_entry: ApiLog;
  entries: ApiLog[];
  tasks: ApiTasks;
  summary: Record<string, number>;
  allowed_actions: string[];
};
type TestApi = Omit<PluginApi, "core" | "query" | "data"> & {
  core: {
    version: 1;
    run(args?: { op?: unknown; input?: unknown }): Promise<ApiObject>;
    batch(input?: { operations?: unknown; if_state_revision?: unknown }): Promise<ApiObject>;
  };
  query: {
    snapshot?(): Promise<ApiObject>;
    node(id: string): Promise<ApiObject>;
    context(id: string): Promise<ApiObject>;
    status(options?: Record<string, unknown>): Promise<ApiObject>;
    history(id: string, options?: Record<string, unknown>): Promise<ApiObject>;
  };
  data: {
    node: { get(id: string): Promise<unknown>; set(id: string, value: unknown): Promise<unknown>; delete(id: string): Promise<unknown> };
    project: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<unknown> };
  };
};

function baseNodes(): Record<string, FixtureNode> {
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

export function baseState(): FixtureState {
  return {
    version: 5,
    revision: 0,
    nodes: baseNodes(),
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { p: { desc: "plugin platform", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

export async function seedState(dir: string, mutate?: SeedMutator): Promise<{ revision: number }> {
  const base = baseState();
  if (typeof mutate === "function") {
    mutate(base);
  }
  try {
    const current = await readRawState(dir);
    base.revision = current.revision;
    base.fence_generation = current.fence_generation;
  } catch (error) {
    const isMissingState = typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT";
    if (!isMissingState) {
      throw error;
    }
    base.revision = 0;
    delete base.fence_generation;
  }
  return writeFencedState(dir, base);
}

export async function freshApi(dir: string, opts: ApiOptions = {}): Promise<TestApi> {
  const { createApi } = await importFresh("./plugins/api.ts");
  return createApi({
    projectDir: dir,
    agent: opts.agent === undefined ? "tester" : opts.agent,
    pluginId: opts.pluginId || "example.audit",
  }) as TestApi;
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
