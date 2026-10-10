import type { BackendClient, ProjectConfig, SourceInput } from "../../application/types.ts";

export type CliNode = Record<string, unknown> & {
  id: string;
  kind?: string;
  subkind?: string;
  status?: string;
  revision?: number;
  claim?: Record<string, unknown> | null;
};
export type CliMutation = {
  result?: Record<string, unknown> | null;
  effects?: Record<string, unknown> | null;
  diff: {
    updated: Array<{ id: string; node?: CliNode }>;
    initiatives?: { created: Array<{ name: string; initiative?: Record<string, unknown> }> };
    created?: Array<{ id: string; node?: CliNode }>;
    target_revision?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type CliError = Error & { code?: string; details?: Record<string, unknown>; cause?: unknown };
export type CliBackendClient = BackendClient & {
  insecureRemoteHttp?: boolean;
  operationSource?: Promise<SourceInput>;
  init: () => Promise<{ seeded?: unknown }>;
  renameProject?: (name: string) => Promise<unknown>;
  readStatus: (filters: Record<string, unknown>) => Promise<unknown>;
  readContext: (options: Record<string, unknown>) => Promise<unknown>;
  readHistory: (options: Record<string, unknown>) => Promise<unknown>;
  readInitiatives: (options: Record<string, unknown>) => Promise<unknown>;
  readLog: (options: Record<string, unknown>) => Promise<unknown>;
  readSearch: (options: Record<string, unknown>) => Promise<unknown>;
  readState: () => Promise<unknown>;
  readNode: (options: { id: string }) => Promise<{ node?: CliNode | null } | null>;
};

export type CliFlagValue = string | boolean;
export type CliFlags = Record<string, CliFlagValue | undefined>;

export type CommandContext = {
  command: string;
  originalArgv: string[];
  flags: CliFlags;
  positional: string[];
  projectDir: string;
  statePath: string;
  projectConfig: ProjectConfig;
  backendClient?: CliBackendClient;
  source?: SourceInput;
  pluginId?: string;
  write?: (value: string) => void;
};

export type CommandModule = {
  knownFlags?: readonly string[];
  default: (context: CommandContext) => Promise<unknown> | unknown;
};

export type CommandLoader = () => Promise<unknown>;

export type DispatchOptions = Partial<CommandContext> & {
  command?: string | null;
  dispatchPlugin?: (...args: never[]) => Promise<unknown>;
  hasInstalledPlugin?: (...args: never[]) => Promise<boolean>;
};
