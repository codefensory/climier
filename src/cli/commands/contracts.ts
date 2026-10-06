import type { BackendClient, ProjectConfig, SourceInput } from "../../application/types.ts";

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
  backendClient?: BackendClient & Record<string, unknown>;
  source?: SourceInput;
  pluginId?: string;
};

export type CommandModule = {
  knownFlags?: readonly string[];
  default: (context: CommandContext) => Promise<unknown> | unknown;
};

export type CommandLoader = () => Promise<CommandModule>;

export type DispatchOptions = Partial<CommandContext> & {
  command?: string | null;
  dispatchPlugin?: (...args: never[]) => Promise<unknown>;
  hasInstalledPlugin?: (...args: never[]) => Promise<boolean>;
};
