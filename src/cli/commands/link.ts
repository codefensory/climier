import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseBackendConfig } from "../../application/backend-config.ts";
import { projectMetaFile } from "../../storage/paths.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";

type LinkMetadata = { version?: unknown; project_id?: unknown; backend?: { type?: unknown; url?: unknown } } & Record<string, unknown>;

export const knownFlags = ["replace"];

function linkError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function usage(message, details) {
  return linkError("CLI_USAGE_ERROR", `link: ${message}`, details);
}

function normalizeReplace(value) {
  if (value === undefined || value === false) {return false;}
  if (value === true || value === "true") {return true;}
  if (value === "false") {return false;}
  throw usage("--replace must be true or false", { flag: "replace" });
}

function newProjectId() {
  return crypto.randomBytes(16).toString("base64url");
}

async function readMetadata(file: string): Promise<LinkMetadata> {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code === "ENOENT") {return {};}
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw linkError("CLIMIER_CORRUPT_PROJECT_META", `link: project metadata at ${file} must be a JSON object`, { file });
    }
    return parsed;
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code) {throw error;}
    throw linkError("CLIMIER_CORRUPT_PROJECT_META", `link: project metadata at ${file} is corrupt or not valid JSON: ${error.message}`, { file });
  }
}

function normalizedRemoteBackend(origin: string): { type: "remote"; url: string } {
  const backend = parseBackendConfig({ backend: { type: "remote", url: origin } });
  if (backend.type !== "remote") { throw new Error("link: remote backend configuration was not selected"); }
  return { type: "remote", url: backend.url };
}

function currentRemoteOrigin(meta: LinkMetadata): string | null {
  if (meta.backend?.type !== "remote") {return null;}
  return typeof meta.backend.url === "string" ? normalizedRemoteBackend(meta.backend.url).url : null;
}

function updatedMetadata(meta: LinkMetadata, backend: { type: "remote"; url: string }): LinkMetadata {
  return {
    ...meta,
    version: Number.isInteger(meta.version) ? meta.version : 1,
    project_id: typeof meta.project_id === "string" && meta.project_id.trim() ? meta.project_id : newProjectId(),
    backend,
  };
}

export default async function link({ positional, flags, projectDir }: CommandContext) {
  if (positional.length !== 1) {throw usage("expected exactly one origin", { positional_count: positional.length });}
  const replace = normalizeReplace(flags.replace);
  const backend = normalizedRemoteBackend(positional[0]);
  const file = projectMetaFile(projectDir);
  const meta = await readMetadata(file);
  const currentOrigin = currentRemoteOrigin(meta);
  if (currentOrigin && currentOrigin !== backend.url && !replace) {
    throw linkError("LINK_REPLACE_REQUIRED", "link: remote origin already configured; pass --replace=true to change it", {
      current: currentOrigin,
      requested: backend.url,
    });
  }

  const next = updatedMetadata(meta, backend);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { project: { project_id: next.project_id, backend: next.backend } };
}
