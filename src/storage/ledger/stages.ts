import { asCaughtError } from "../../contracts/errors.ts";
// Shared durable-stage and fingerprint primitives for private ledger protocols.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ClimierError } from "../../contracts/errors.ts";
import { isFencedStateVersion } from "../state.ts";
import { validateStateInvariants } from "../../contracts/state-invariants.ts";

export type NodeRecord = { revision?: number; [key: string]: unknown };
export type StateLike = { version?: number; fence_generation?: number; revision?: number; nodes?: Record<string, NodeRecord>; log?: Array<Record<string, unknown>>; [key: string]: unknown };
export type LedgerLike = { fence_generation: number; high_water_revision: number; [key: string]: unknown };

const injectedFault = "injected failure";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function assertFencedMigrationSource(state: StateLike, ledger: LedgerLike): StateLike {
  if (!state || state.version !== 5
      || !ledger || !Number.isInteger(ledger.fence_generation)
      || !Number.isInteger(ledger.high_water_revision)
      || state.fence_generation !== ledger.fence_generation
      || !Number.isInteger(state.revision) || state.revision !== ledger.high_water_revision
      || maxNodeRevision(state) > ledger.high_water_revision) {
    throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: fenced migration source and revision ledger are inconsistent");
  }
  validateStateInvariants(state, "ledger.migrate.source");
  return state;
}

export function hasFencedSchemaMigrationEntry(state: StateLike): boolean {
  return Array.isArray(state?.log) && state.log.some((entry) => entry?.action === "migrate"
    && entry?.agent === "migrate" && entry?.from_version === 5 && entry?.to_version === 1);
}

export function isSchemaMigratedState(state: StateLike, ledger: LedgerLike): boolean {
  return state?.version === 1
    && state.fence_generation === ledger?.fence_generation
    && Number.isInteger(state.revision)
    && state.revision === ledger?.high_water_revision
    && hasFencedSchemaMigrationEntry(state);
}

export function assertFencedState(state: StateLike, ledger: LedgerLike): void {
  if (!state || !isFencedStateVersion(state.version)) {
    throw new ClimierError("CLIMIER_INCOMPATIBLE_VERSION", "ledger: state is not canonical version 1; restore a verified backup or contact the maintainer.");
  }
  if (state.fence_generation !== ledger.fence_generation
      || !Number.isInteger(state.revision) || state.revision !== ledger.high_water_revision
      || maxNodeRevision(state) > ledger.high_water_revision) {
    throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: state and revision ledger are inconsistent");
  }
  validateStateInvariants(state, "ledger.read");
}

export function assertSchemaMigratedState(state: StateLike, ledger: LedgerLike, expectedRevision: number): StateLike {
  if (state?.version !== 1
      || state.fence_generation !== ledger?.fence_generation
      || state.revision !== expectedRevision
      || state.revision !== ledger?.high_water_revision
      || !hasFencedSchemaMigrationEntry(state)
      || maxNodeRevision(state) > ledger.high_water_revision) {
    throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: schema migration state and revision ledger are inconsistent");
  }
  validateStateInvariants(state, "ledger.schema-migration");
  return state;
}

export function assertSchemaMigrationDestination(source: StateLike, destination: StateLike, sourceLedger: LedgerLike, destinationLedger: LedgerLike): StateLike {
  assertFencedMigrationSource(source, sourceLedger);
  assertSchemaMigratedState(destination, destinationLedger, destinationLedger.high_water_revision);
  const { version: _version, revision: _revision, log: _log, ...sourceData } = source;
  const { version: _destinationVersion, revision: _destinationRevision, log: _destinationLog, ...destinationData } = destination;
  const sourceLog = source.log || [];
  const destinationLog = destination.log || [];
  if (JSON.stringify(sourceData) !== JSON.stringify(destinationData)
      || destinationLog.length !== sourceLog.length + 1
      || JSON.stringify(destinationLog.slice(0, -1)) !== JSON.stringify(sourceLog)) {
    throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: schema migration changed data outside schema, revision, and migration log");
  }
  for (const [id, node] of Object.entries(source.nodes || {})) {
    if (!destination.nodes?.[id] || destination.nodes[id].revision !== node.revision) {
      throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", `ledger: schema migration changed node ${id} revision`);
    }
  }
  return destination;
}

export function maxNodeRevision(state: StateLike): number {
  let max = 0;
  for (const node of Object.values(state.nodes || {})) {
    const revision = node?.revision;
    if (typeof revision === "number" && Number.isInteger(revision) && revision > max) { max = revision; }
  }
  return max;
}

export function readJson(raw: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (rawCaughtValue: unknown) {
  {
    const cause = asCaughtError(rawCaughtValue);
    throw new ClimierError("CLIMIER_CORRUPT_LEDGER", `ledger: ${label} is corrupt or not valid JSON: ${cause.message}`, {}, { cause });

  }}
}

export async function durableReplace(file, raw) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await syncDirectory(dir);
}

export async function persistLedger(file, ledger) {
  await durableReplace(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

export async function durableCreate(file, raw) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dir);
  try {
    await fs.link(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") {
      throw error;
    }
    });
  }
  await syncDirectory(dir);
}

export function bootstrapStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.bootstrap-stage-${stageId}`);
}

export function recoveryStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.recovery-stage-${stageId}`);
}

export async function cleanOrphanRecoveryStages(statePath) {
  const directory = path.dirname(statePath);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      return;
    }
    throw error;

  }}
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && /^\\.recovery-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) { await syncDirectory(directory); }
}

export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  // Windows cannot fsync directory handles; file contents are still synced before publication.
  if (platform === "win32") {return;}
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function fault(opts, point) {
  if (opts.faultAt === point) {
    throw new Error(`${injectedFault} at ${point}`);
  }
}

export function commitStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.commit-stage-${stageId}`);
}

export function fingerprintMismatch(message) {
  return new ClimierError("CLIMIER_LEDGER_FINGERPRINT_MISMATCH", `ledger: ${message}`);
}

export async function writeDurableStage(stagePath, destinationRaw) {
  const handle = await fs.open(stagePath, "wx", 0o600);
  try {
    await handle.writeFile(destinationRaw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(stagePath));
}
