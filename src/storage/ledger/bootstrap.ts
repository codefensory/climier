import { asCaughtError } from "../../contracts/errors.ts";
// Durable fenced bootstrap and initial-state protocol.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, STATE_SCHEMA_VERSION } from "../state.ts";
import { assertActiveLockContext, getActiveLockContext } from "../lock.ts";
import { ClimierError } from "../../contracts/errors.ts";
import { validateStateInvariants } from "../../contracts/state-invariants.ts";
import { assertValidLedger, LEDGER_VERSION, SOURCE_VERSIONS } from "./recovery.ts";

import { assertFencedState, bootstrapStagePath, durableCreate, durableReplace, fault, fingerprintMismatch, maxNodeRevision, persistLedger, readJson, sha256, syncDirectory, writeDurableStage } from "./stages.ts";

type JsonRecord = Record<string, unknown>;
type InitialState = JsonRecord & {
  version?: number;
  revision?: number;
  nodes?: Record<string, JsonRecord & { revision?: number }>;
};
type PreparedBootstrap = { destination: InitialState; destinationRaw: string; highWater: number };
type BootstrapPending = {
  source_sha256?: string;
  destination_sha256: string;
  stage_id: string;
  fence_generation: number;
  high_water_revision: number;
};
export type BootstrapLedger = JsonRecord & {
  bootstrap_pending: BootstrapPending | null;
  high_water_revision: number;
  fence_generation: number;
};
type BootstrapOptions = {
  projectDir?: string;
  replaceExisting?: boolean;
  faultAt?: string;
  onCheckpoint?: (point: string) => void | Promise<void>;
  [key: string]: unknown;
};

type BootstrapHandlers = {
  finishPendingCommit: (args: {
    statePath: string;
    ledgerPath: string;
    ledger: unknown;
    rawState: string;
    opts?: BootstrapOptions;
  }) => Promise<unknown>;
  cleanOrphanCommitStages: (statePath: string) => Promise<void>;
};

function ledgerFile(projectDir: string): string {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function assertSupportedInitialState(initialState: unknown): asserts initialState is InitialState {
  const candidate = initialState as InitialState | null;
  const supported = candidate?.version === STATE_SCHEMA_VERSION
    || (candidate?.version !== undefined && SOURCE_VERSIONS.has(candidate.version));
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !supported) {
    throw new ClimierError("CLIMIER_UNSUPPORTED_SOURCE_VERSION", `ledger.bootstrap: unsupported initial state version ${candidate?.version}`);
  }
}

function fencedInitialState(initialState: unknown): PreparedBootstrap {
  assertSupportedInitialState(initialState);
  const compatible = {
    ...initialState,
    version: STATE_SCHEMA_VERSION,
    nodes: Object.fromEntries(Object.entries(initialState.nodes || {}).map(([id, node]) => [id, { ...node }])),
  };
  validateStateInvariants(compatible, "ledger.bootstrap.initial");
  const compatibleRevision = compatible.revision;
  const highWater = Math.max(
    typeof compatibleRevision === "number" && Number.isInteger(compatibleRevision) && compatibleRevision >= 0 ? compatibleRevision : 0,
    maxNodeRevision(compatible),
  );
  const fence = highWater + 1;
  const destination = {
    ...compatible,
    version: STATE_SCHEMA_VERSION,
    revision: fence,
    fence_generation: 1,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.bootstrap.initial.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence };
}

async function readPendingBootstrapStage(stagePath, pending, ledger) {
  let staged;
  try {
    staged = await fs.readFile(stagePath, "utf8");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      throw fingerprintMismatch("bootstrap stage is missing; explicit recovery is required");
    }
    throw error;

  }}
  if (sha256(staged) !== pending.destination_sha256) {
    throw fingerprintMismatch("bootstrap stage does not match the pending destination fingerprint");
  }
  assertFencedState(readJson(staged, "bootstrap stage"), ledger);
  return staged;
}

async function publishPendingBootstrapStage(stagePath, statePath, pending, staged) {
  try {
    await fs.link(stagePath, statePath);
    await syncDirectory(path.dirname(statePath));
    return staged;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code !== "EEXIST") {
      throw error;
    }
    const rawState = await fs.readFile(statePath, "utf8");
    if (sha256(rawState) !== pending.destination_sha256) {
      throw fingerprintMismatch("state appeared with a different bootstrap destination");
    }
    return rawState;

  }}
}

async function checkpoint(opts, point) {
  fault(opts, point);
  if (typeof opts.onCheckpoint === "function") {
    await opts.onCheckpoint(point);
  }
}

async function replacePendingBootstrapSource(statePath, stagePath, pending, ledger, rawState, opts) {
  if (!pending.source_sha256 || sha256(rawState) !== pending.source_sha256) {
    throw fingerprintMismatch("state diverged from the pending bootstrap source and destination");
  }
  const staged = await readPendingBootstrapStage(stagePath, pending, ledger);
  await checkpoint(opts, "before-state-replace");
  await durableReplace(statePath, staged);
  await checkpoint(opts, "after-state-replace");
  return staged;
}

async function readPendingBootstrapState(statePath, stagePath, pending, ledger, opts) {
  try {
    const rawState = await fs.readFile(statePath, "utf8");
    const currentHash = sha256(rawState);
    if (currentHash === pending.destination_sha256) {
      return rawState;
    }
    if (pending.source_sha256 && currentHash === pending.source_sha256) {
      return replacePendingBootstrapSource(statePath, stagePath, pending, ledger, rawState, opts);
    }
    throw fingerprintMismatch("state diverged from the pending bootstrap source and destination");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code !== "ENOENT") {
      throw error;
    }
    const staged = await readPendingBootstrapStage(stagePath, pending, ledger);
    if (pending.source_sha256) {
      await checkpoint(opts, "before-state-replace");
      await durableReplace(statePath, staged);
      await checkpoint(opts, "after-state-replace");
      return staged;
    }
    return publishPendingBootstrapStage(stagePath, statePath, pending, staged);

  }}
}

async function clearPendingBootstrap({ stagePath, statePath, ledgerPath, ledger, state }) {
  assertFencedState(state, ledger);
  ledger.bootstrap_pending = null;
  await persistLedger(ledgerPath, ledger);
  await fs.unlink(stagePath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await syncDirectory(path.dirname(statePath));
  return state;
}

async function finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw, opts = {} }: {
  statePath: string;
  ledgerPath: string;
  ledger: BootstrapLedger;
  expectedDestinationRaw?: string;
  opts?: BootstrapOptions;
}): Promise<unknown> {
  const pending = ledger.bootstrap_pending;
  if (!pending) {
    return null;
  }
  if (expectedDestinationRaw && sha256(expectedDestinationRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("retry initial state does not match the pending bootstrap destination");
  }
  const stagePath = bootstrapStagePath(statePath, pending.stage_id);
  const rawState = await readPendingBootstrapState(statePath, stagePath, pending, ledger, opts);
  const state = readJson(rawState, "bootstrapped state");
  return clearPendingBootstrap({ stagePath, statePath, ledgerPath, ledger, state });
}

async function cleanOrphanBootstrapStages(statePath) {
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
    if (entry.isFile() && /^\\.bootstrap-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) {
    await syncDirectory(directory);
  }
}

function bootstrapExists() {
  return new ClimierError("CLIMIER_FENCED_BOOTSTRAP_EXISTS", "ledger.bootstrap: state or revision ledger already exists; refusing to overwrite it");
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;

  }}
}

async function loadExistingBootstrapLedger(ledgerPath: string): Promise<BootstrapLedger> {
  try {
    const ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger") as BootstrapLedger;
    assertValidLedger(ledger);
    return ledger;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT"
        || error.code === "CLIMIER_CORRUPT_LEDGER"
        || error.code === "CLIMIER_INVALID_LEDGER") {
      throw bootstrapExists();
    }
    throw error;

  }}
}

function hasPendingBootstrap(ledger: BootstrapLedger): boolean {
  return ledger.bootstrap_pending !== null && ledger.bootstrap_pending !== undefined;
}

function makeBootstrapLedger(prepared: PreparedBootstrap, destinationHash: string, stageId: string, sourceRaw: string | null = null): BootstrapLedger {
  return {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: prepared.highWater,
    commit_pending: null,
    bootstrap_pending: {
      ...(sourceRaw === null ? {} : { source_sha256: sha256(sourceRaw) }),
      destination_sha256: destinationHash,
      stage_id: stageId,
      fence_generation: 1,
      high_water_revision: prepared.highWater,
    },
  };
}

async function createPendingBootstrap({ stagePath, ledgerPath, statePath, prepared, ledger, opts }: {
  stagePath: string;
  ledgerPath: string;
  statePath: string;
  prepared: PreparedBootstrap;
  ledger: BootstrapLedger;
  opts: BootstrapOptions;
}): Promise<unknown> {
  await writeDurableStage(stagePath, prepared.destinationRaw);
  await checkpoint(opts, "before-pending");
  await durableCreate(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await checkpoint(opts, "after-pending");
  const pending = ledger.bootstrap_pending;
  if (await fileExists(statePath) && pending?.source_sha256) {
    const sourceRaw = await fs.readFile(statePath, "utf8");
    await replacePendingBootstrapSource(statePath, stagePath, pending, ledger, sourceRaw, opts);
  } else {
    try {
      await fs.link(stagePath, statePath);
    } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
      if (error.code === "EEXIST") {
        throw bootstrapExists();
      }
      throw error;

  }}
    await syncDirectory(path.dirname(statePath));
  }
  fault(opts, "after-state-create");
  return finishPendingBootstrap({
    statePath,
    ledgerPath,
    ledger,
    expectedDestinationRaw: prepared.destinationRaw,
    opts,
  });
}

export async function bootstrapInitialUnderLock(lockContext: object, initialState: unknown, opts: BootstrapOptions = {}): Promise<unknown> {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const prepared = fencedInitialState(initialState);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  if (await fileExists(ledgerPath)) {
    const ledger = await loadExistingBootstrapLedger(ledgerPath);
    if (!hasPendingBootstrap(ledger)) {
      throw bootstrapExists();
    }
    return finishPendingBootstrap({
      statePath,
      ledgerPath,
      ledger,
      expectedDestinationRaw: prepared.destinationRaw,
    });
  }
  if (await fileExists(statePath) && opts.replaceExisting !== true) {
    throw bootstrapExists();
  }
  return createInitialBootstrap({ statePath, ledgerPath, prepared, opts });
}

async function createInitialBootstrap({ statePath, ledgerPath, prepared, opts, sourceRaw = null }: {
  statePath: string;
  ledgerPath: string;
  prepared: PreparedBootstrap;
  opts: BootstrapOptions;
  sourceRaw?: string | null;
}): Promise<unknown> {
  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  const destinationHash = sha256(prepared.destinationRaw);
  const ledger = makeBootstrapLedger(prepared, destinationHash, stageId, sourceRaw);
  if (opts.replaceExisting === true) {
    await writeDurableStage(stagePath, prepared.destinationRaw);
    await checkpoint(opts, "before-pending");
    await durableReplace(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    await checkpoint(opts, "after-pending");
    await checkpoint(opts, "before-state-replace");
    await durableReplace(statePath, prepared.destinationRaw);
    await checkpoint(opts, "after-state-replace");
    fault(opts, "after-state-create");
    return finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw: prepared.destinationRaw, opts });
  }
  return createPendingBootstrap({ stagePath, ledgerPath, statePath, prepared, ledger, opts });
}

async function readOptionalLedger(ledgerPath: string): Promise<BootstrapLedger | null> {
  try {
    return readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger") as BootstrapLedger;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;

  }}
}

async function readOrCreateState(statePath) {
  try {
    return await fs.readFile(statePath, "utf8");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;

  }}
}

async function finishExistingLedger({ statePath, ledgerPath, ledger, rawState, opts }, handlers) {
  assertValidLedger(ledger);
  const state = readJson(rawState, "state");
  if (ledger.commit_pending) {
    return handlers.finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  }
  await handlers.cleanOrphanCommitStages(statePath);
  if (state.version !== STATE_SCHEMA_VERSION) {
    throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: fenced project is missing canonical state marker");
  }
  assertFencedState(state, ledger);
  return state;
}

export async function migrateLegacyInitialUnderLock(lockContext: object, initialState: unknown, sourceRaw: string | null, opts: BootstrapOptions = {}): Promise<unknown> {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  const currentLedger = await readOptionalLedger(ledgerPath);
  const existingState = sourceRaw === null ? null : await readOrCreateState(statePath);
  if (currentLedger) {
    assertValidLedger(currentLedger);
    if (currentLedger.bootstrap_pending) {
      return finishPendingBootstrap({ statePath, ledgerPath, ledger: currentLedger, opts });
    }
    throw bootstrapExists();
  }
  if (sourceRaw !== null && (existingState === null || sha256(existingState) !== sha256(sourceRaw))) {
    throw fingerprintMismatch("legacy migration source changed before bootstrap staging");
  }
  const prepared = fencedInitialState(initialState);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  if (sourceRaw !== null) {
    const targetHighWater = prepared.highWater + 1;
    prepared.destination.revision = targetHighWater;
    for (const node of Object.values(prepared.destination.nodes ?? {})) node.revision = targetHighWater;
    prepared.destinationRaw = `${JSON.stringify(prepared.destination, null, 2)}\n`;
    prepared.highWater = targetHighWater;
  }
  return createInitialBootstrap({ statePath, ledgerPath, prepared, opts: { ...opts, replaceExisting: true }, sourceRaw });
}

async function replaceWithCanonicalBootstrap({ statePath, ledgerPath, prepared, ledger, opts }: {
  statePath: string;
  ledgerPath: string;
  prepared: PreparedBootstrap;
  ledger: BootstrapLedger;
  opts: BootstrapOptions;
}): Promise<unknown> {
  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  ledger.bootstrap_pending = {
    destination_sha256: sha256(prepared.destinationRaw),
    stage_id: stageId,
    fence_generation: ledger.fence_generation,
    high_water_revision: prepared.highWater,
  };
  ledger.high_water_revision = prepared.highWater;
  await writeDurableStage(stagePath, prepared.destinationRaw);
  await checkpoint(opts, "before-pending");
  await durableReplace(ledgerPath, `${JSON.stringify(ledger, null, 2)}\\n`);
  await checkpoint(opts, "after-pending");
  await checkpoint(opts, "before-state-replace");
  await durableReplace(statePath, prepared.destinationRaw);
  await checkpoint(opts, "after-state-replace");
  fault(opts, "after-state-create");
  return finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw: prepared.destinationRaw, opts });
}

function finishBootstrapWithoutState(ledger: BootstrapLedger, statePath: string, ledgerPath: string): Promise<unknown> {
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: revision ledger exists without state and no exact bootstrap is pending");
}

async function bootstrapLocked(projectDir: string, opts: BootstrapOptions, handlers: BootstrapHandlers): Promise<unknown> {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const initialLedger = await readOptionalLedger(ledgerPath);
  if (opts.replaceExisting === true) {
    const source = await readOrCreateState(statePath);
    const priorLedger = initialLedger;
    const highWater = Math.max(
      typeof priorLedger?.high_water_revision === "number" ? priorLedger.high_water_revision : 0,
      source ? (() => { try { return maxNodeRevision(readJson(source, "replaced state")); } catch { return 0; } })() : 0,
    );
    const initial = { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: highWater };
    const prepared = fencedInitialState(initial);
    const ledger = makeBootstrapLedger(prepared, sha256(prepared.destinationRaw), crypto.randomBytes(16).toString("hex"));
    ledger.high_water_revision = highWater + 1;
    return replaceWithCanonicalBootstrap({ statePath, ledgerPath, prepared, ledger, opts });
  }
  if (initialLedger && hasPendingBootstrap(initialLedger)) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger: initialLedger });
  }
  const rawState = await readOrCreateState(statePath);
  const ledger = initialLedger ?? await readOptionalLedger(ledgerPath);
  if (ledger) {
    if (rawState === null) {
      return finishBootstrapWithoutState(ledger, statePath, ledgerPath);
    }
    return finishExistingLedger({ statePath, ledgerPath, ledger, rawState, opts }, handlers);
  }
  if (rawState === null) {
    return createInitialBootstrap({ statePath, ledgerPath, prepared: fencedInitialState({ version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 }), opts });
  }
  throw new ClimierError("CLIMIER_INCOMPATIBLE_VERSION", `ledger.bootstrap: existing state at ${statePath} is not canonical version ${STATE_SCHEMA_VERSION}; run climier migrate`);
}


export { fileExists, finishPendingBootstrap, bootstrapLocked };
