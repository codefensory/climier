import type { BackendClient } from "../application/types.ts";

export type PluginBackendClient = BackendClient;

export type PluginRuntime = {
  project_dir: string;
  agent: string;
  plugin_id?: string;
  dataDir?: string;
};

export type PluginQuery = {
  snapshot?(): Promise<unknown>;
  node(id: string): Promise<unknown>;
  context(id: string): Promise<unknown>;
  status(options?: Record<string, unknown>): Promise<unknown>;
  history(id: string, options?: Record<string, unknown>): Promise<unknown>;
};

export type PluginData = {
  node: {
    get(id: string): Promise<unknown>;
    set(id: string, value: unknown): Promise<unknown>;
    delete?(id: string): Promise<unknown>;
  };
  project: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete?(key: string): Promise<unknown>;
  };
};

export type PluginCore = {
  version: 1;
  run(args?: { op?: unknown; input?: unknown }): Promise<unknown>;
  batch(input?: { operations?: unknown; if_state_revision?: unknown }): Promise<unknown>;
};

export type PluginApi = {
  version?: 1;
  runtime: PluginRuntime;
  query: PluginQuery;
  data: PluginData;
  core?: PluginCore;
};

export type PluginCommand = (tokens: string[], api: PluginApi) => unknown | Promise<unknown>;
export type PluginCommands = Record<string, PluginCommand>;
export type ApiFactory = (args: {
  projectDir: string;
  agent: string;
  pluginId: string;
  backendClient: PluginBackendClient;
}) => PluginApi;
