// Shared durable-stage and fingerprint primitives for private ledger protocols.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isFencedStateVersion } from "../state.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";

const injectedFault = "injected failure";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function assertFencedState(state, ledger) {
  if (!state || !isFencedStateVersion(state.version)
      || state.fence_generation !== ledger.fence_generation
      || !Number.isInteger(state.revision) || state.revision !== ledger.high_water_revision
      || maxNodeRevision(state) > ledger.high_water_revision) {
    const error = new Error("ledger: state and revision ledger are inconsistent or indicate legacy downgrade");
    error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
    throw error;
  }
  validateStateInvariants(state, "ledger.read");
}

export function maxNodeRevision(state) {
  let max = 0;
  for (const node of Object.values(state.nodes || {})) {
    if (Number.isInteger(node?.revision) && node.revision > max) { max = node.revision; }
  }
  return max;
}

export function readJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`ledger: ${label} is corrupt or not valid JSON: ${cause.message}`, { cause });
    error.code = "CLIMIER_CORRUPT_LEDGER";
    throw error;
  }
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
  const dirHandle = await fs.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
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
  const dirHandle = await fs.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
  try {
    await fs.link(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") {
      throw error;
    }
    });
  }
  const syncedDir = await fs.open(dir, "r");
  try {
    await syncedDir.sync();
  } finally {
    await syncedDir.close();
  }
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
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && /^\\.recovery-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) { await syncDirectory(directory); }
}

export async function syncDirectory(directory) {
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
  const error = new Error(`ledger: ${message}`);
  error.code = "CLIMIER_LEDGER_FINGERPRINT_MISMATCH";
  return error;
}

export async function writeDurableStage(stagePath, destinationRaw) {
  const handle = await fs.open(stagePath, "wx", 0o600);
  try {
    await handle.writeFile(destinationRaw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(stagePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
