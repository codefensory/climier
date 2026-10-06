import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { climierHome } from "./paths.ts";

const DIRECTORY = "remote-transfer-baselines";
const BASELINE_KEYS = ["version", "origin", "project_id", "remote_revision", "local_revision"];

function baselineError(message, cause) {
  const error = new Error(`remote transfer baseline: ${message}`);
  error.code = "REMOTE_TRANSFER_BASELINE_ERROR";
  if (cause) {error.cause = cause;}
  return error;
}

function validateIdentity(origin, projectId) {
  if (typeof origin !== "string" || !origin.trim()) {
    throw baselineError("origin must be a non-empty string");
  }
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw baselineError("project_id must be a non-empty string");
  }
}

function validateBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== BASELINE_KEYS.length
    || !BASELINE_KEYS.every((key) => Object.hasOwn(value, key))
    || value.version !== 1
    || typeof value.origin !== "string" || !value.origin.trim()
    || typeof value.project_id !== "string" || !value.project_id.trim()
    || !Number.isInteger(value.remote_revision) || value.remote_revision < 0
    || !Number.isInteger(value.local_revision) || value.local_revision < 0) {
    throw baselineError("record is corrupt or does not match version 1 schema");
  }
  return {
    version: 1,
    origin: value.origin,
    project_id: value.project_id,
    remote_revision: value.remote_revision,
    local_revision: value.local_revision,
  };
}

function fileName(origin, projectId) {
  const identity = JSON.stringify([origin, projectId]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${digest}.json`;
}

export function createRemoteTransferBaselineStore({ home = climierHome() } = {}) {
  const directory = path.join(path.resolve(home), DIRECTORY);

  async function read(origin, projectId) {
    validateIdentity(origin, projectId);
    const file = path.join(directory, fileName(origin, projectId));
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {return null;}
      throw baselineError(`cannot read ${file}: ${error.message}`, error);
    }

    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw baselineError(`record at ${file} is corrupt`, error);
    }
    const baseline = validateBaseline(value);
    if (baseline.origin !== origin || baseline.project_id !== projectId) {
      throw baselineError(`record at ${file} does not match its origin and project_id`);
    }
    return baseline;
  }

  return Object.freeze({
    async get(origin, projectId) {
      return read(origin, projectId);
    },
    async set(value) {
      const baseline = validateBaseline(value);
      const file = path.join(directory, fileName(baseline.origin, baseline.project_id));

      // Do not repair or overwrite a malformed record without an explicit recovery path.
      await read(baseline.origin, baseline.project_id);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, file);
        await fs.chmod(file, 0o600);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw baselineError(`cannot persist ${file}: ${error.message}`, error);
      }
    },
  });
}
