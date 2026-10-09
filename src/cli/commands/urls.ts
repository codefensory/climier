import path from "node:path";

import { buildUiUrls, type UiUrlNode } from "../../read-model/urls.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { stateFile, readState } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = ["initiative", "id", "port", "origin"];

const DEFAULT_PORT = 7373;
const LOOPBACK_HOST = "127.0.0.1";

type UrlTarget = { initiative?: string; node?: { id: string; kind?: string; subkind?: string } };

function usage(message: string): never {
  const error = new Error(`urls: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  throw error;
}

function requiredText(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return usage(`--${flag} requires a non-empty value`);
  }
  return value;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    return usage("--origin requires an absolute HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return usage("--origin must be an absolute HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.search || url.hash) {
    return usage("--origin must be an HTTP(S) URL without credentials, search, or hash");
  }
  return url.origin;
}

function parsePort(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number")
      || (typeof value === "string" && value.trim().length === 0)) {
    return usage("--port must be an integer from 1 to 65535");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return usage("--port must be an integer from 1 to 65535");
  }
  return port;
}

function projectIdForLocal(projectDir: string): string {
  return path.basename(path.dirname(stateFile(projectDir)));
}

function remoteOrigin(projectConfig: CommandContext["projectConfig"]): string {
  const backend = projectConfig.backend;
  if (!backend || typeof backend !== "object" || Array.isArray(backend) || typeof backend.url !== "string") {
    return usage("remote backend is missing its URL");
  }
  return normalizeOrigin(backend.url);
}

function hasInitiative(snapshot: ReadModelSnapshot | null, initiative: string): boolean {
  return Boolean(snapshot && snapshot.initiatives && Object.hasOwn(snapshot.initiatives, initiative));
}

function hasNode(snapshot: ReadModelSnapshot | null, id: string) {
  return snapshot?.nodes?.[id] || null;
}

function missingInitiative(initiative: string): never {
  throwV2("INITIATIVE_NOT_FOUND", `urls: initiative ${initiative} not found`, { initiative });
}

function missingNode(id: string): never {
  throwV2("NODE_NOT_FOUND", `urls: node ${id} not found`, { id });
}

function normalizeUrlNode(node: NonNullable<UrlTarget["node"]>): UiUrlNode {
  return { ...node, kind: node.kind ?? "task" };
}

async function resolveRemoteTarget({ initiative, id, backendClient }: UrlTarget & { id?: string; backendClient: NonNullable<CommandContext["backendClient"]> }): Promise<UrlTarget> {
  if (initiative !== undefined) {
    const result = await backendClient.readInitiatives({ all: true }) as { initiatives?: Array<{ name?: unknown }> } | null;
    if (!result?.initiatives?.some((item) => item && item.name === initiative)) {
      missingInitiative(initiative);
    }
    return { initiative };
  }
  if (id !== undefined) {
    const result = await backendClient.readNode({ id });
    if (!result?.node) {
      missingNode(id);
    }
    return { node: result.node };
  }
  return {};
}

async function resolveLocalTarget({ initiative, id, statePath }: UrlTarget & { id?: string; statePath: string }): Promise<UrlTarget> {
  if (initiative === undefined && id === undefined) {
    return {};
  }
  const snapshot = await readState(statePath) as ReadModelSnapshot | null;
  if (initiative !== undefined) {
    if (!hasInitiative(snapshot, initiative)) {
      missingInitiative(initiative);
    }
    return { initiative };
  }
  const node = hasNode(snapshot, id!);
  if (!node) {
    missingNode(id!);
  }
  return { node };
}

export default async function urlsCommand({ projectDir, statePath, projectConfig, backendClient, flags, positional }: CommandContext) {
  if (positional.length > 0) {
    usage("does not accept positional arguments");
  }
  const hasInitiativeFlag = flags.initiative !== undefined;
  const hasIdFlag = flags.id !== undefined;
  const hasOriginFlag = flags.origin !== undefined;
  const hasPortFlag = flags.port !== undefined;
  if (hasInitiativeFlag && hasIdFlag) {
    usage("--initiative and --id are mutually exclusive");
  }
  if (hasOriginFlag && hasPortFlag) {
    usage("--origin and --port are mutually exclusive");
  }

  const initiative = hasInitiativeFlag ? requiredText(flags.initiative, "initiative") : undefined;
  const id = hasIdFlag ? requiredText(flags.id, "id") : undefined;
  const explicitOrigin = hasOriginFlag ? normalizeOrigin(flags.origin) : undefined;
  const port = hasPortFlag ? parsePort(flags.port) : DEFAULT_PORT;
  const configuredRemote = backendClient?.type === "remote" || projectConfig.backend?.type === "remote";
  const remote = configuredRemote || explicitOrigin !== undefined;
  const origin = explicitOrigin
    ?? (configuredRemote ? remoteOrigin(projectConfig) : `http://${LOOPBACK_HOST}:${port}`);
  const projectId = configuredRemote
    ? requiredText(projectConfig.project_id, "project_id")
    : projectIdForLocal(projectDir);

  const target = configuredRemote
    ? await resolveRemoteTarget({ initiative, id, backendClient: backendClient! })
    : await resolveLocalTarget({ initiative, id, statePath });

  return {
    ui: {
      origin,
      backend: remote ? "remote" : "local",
      project_id: projectId,
      local_only: !remote,
      urls: buildUiUrls({
        origin,
        projectId,
        initiative: target.initiative,
        node: target.node ? normalizeUrlNode(target.node) : undefined,
      }),
    },
  };
}
