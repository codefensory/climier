// Trusted state operations used by the kernel frontier.
//
// These operations intentionally are not registry entries: state bootstrap,
// force-init and restore are recovery primitives, not agent-facing core ops.
// They provide prepare/apply semantics to kernel.mutate; only the kernel owns
// the lock, snapshot creation, atomic state write and restore log.
import fs from "node:fs/promises";
import path from "node:path";
import { mutate } from "./mutate.mjs";
import {
  emptyState,
  migrateState,
  stateFile,
  snapshotDir,
} from "../storage/state.mjs";
import { requireAgent } from "../contracts/agent.mjs";
import { throwV2 } from "../contracts/errors.mjs";

const REQUIRED_COLLECTIONS = ["nodes", "edges", "initiatives", "log"];
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateSnapshotMetadata(meta, id) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.id !== id) {
    throwV2("NODE_NOT_FOUND", `state.restore: snapshot ${id} metadata is invalid`, { id });
  }
}

function parseSnapshot(raw, id) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throwV2("INVALID_STATUS", `state.restore: snapshot ${id} raw is not valid JSON`, { id, error: err.message });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.version !== 2 && parsed.version !== 3)) {
    throwV2("INVALID_STATUS", `state.restore: snapshot ${id} is not a supported v3 state`, { id, version: parsed && parsed.version });
  }
  for (const field of REQUIRED_COLLECTIONS) {
    if (!(field in parsed)) {
      throwV2("INVALID_STATUS", `state.restore: snapshot ${id} is missing '${field}' collection`, { id, missing: field });
    }
  }
  return migrateState(parsed);
}

const initOperation = Object.freeze({
  async prepare({ projectDir, snapshot, input }) {
    const force = input && input.force === true;
    if (!force && snapshot.exists) {
      // A corrupt JSON file is the one non-force recovery supported by the
      // existing init contract. Unsupported versions must remain visible to
      // the caller instead of being silently reset.
      if (snapshot.stateError && snapshot.stateError.code !== "CLIMIER_CORRUPT_STATE") {
        throw snapshot.stateError;
      }
      if (!snapshot.stateError) {
        throw new Error(`state.init: state file already exists at ${stateFile(projectDir)} (use --force to overwrite)`);
      }
    }
    return Object.freeze({
      target: Object.freeze({ id: "state", kind: "state", state_file: stateFile(projectDir), exists: snapshot.exists }),
      snapshotReason: snapshot.exists ? (force ? "force-init" : "corrupt-recovery") : null,
      force,
    });
  },
  async apply({ snapshot, plan }) {
    const fresh = emptyState();
    if (plan.force && snapshot.state && snapshot.state.plugins && typeof snapshot.state.plugins === "object" && !Array.isArray(snapshot.state.plugins)) {
      fresh.plugins = snapshot.state.plugins;
    }
    return { state: fresh, result: { seeded: null }, effects: null };
  },
});

const restoreOperation = Object.freeze({
  async prepare({ projectDir, snapshot, input }) {
    const id = input && input.snapshot_id;
    if (typeof id !== "string" || !id || !SNAPSHOT_ID_RE.test(id) || id.includes("..")) {
      throwV2("MISSING_FIELD", "state.restore: snapshot id required", { field: "snapshot_id" });
    }
    if (!snapshot.exists) {
      throwV2("INVALID_STATUS", "state.restore: no current state file; cannot pre-snapshot before restoring", { id });
    }
    const dir = snapshotDir(projectDir);
    const metaPath = path.join(dir, `${id}.meta.json`);
    const rawPath = path.join(dir, `${id}.json`);
    let metaRaw;
    try {
      metaRaw = await fs.readFile(metaPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throwV2("NODE_NOT_FOUND", `state.restore: snapshot ${id} not found`, { id });
      throw err;
    }
    let meta;
    try { meta = JSON.parse(metaRaw); } catch (err) {
      throwV2("NODE_NOT_FOUND", `state.restore: snapshot ${id} metadata is corrupt`, { id, error: err.message });
    }
    validateSnapshotMetadata(meta, id);
    let raw;
    try { raw = await fs.readFile(rawPath); } catch (err) {
      if (err.code === "ENOENT") throwV2("NODE_NOT_FOUND", `state.restore: snapshot ${id} is incomplete`, { id });
      throw err;
    }
    const restored = parseSnapshot(raw, id);
    return Object.freeze({
      target: Object.freeze({ id, kind: "snapshot", snapshot: meta }),
      restored,
      snapshotMeta: meta,
      snapshotReason: "pre-restore",
      logAction: "restore",
      log: { snapshot_id: id },
    });
  },
  async apply({ plan }) {
    return { state: plan.restored, result: { snapshot: plan.snapshotMeta }, effects: null };
  },
});

function operationRequest(action, actor, input) {
  return { action, actor, input };
}

/** Execute normal bootstrap or force-init through kernel.mutate. */
export async function initState({ projectDir, force = false, actor, policyAction, pluginId } = {}) {
  const isForce = force === true;
  const resolvedActor = isForce ? requireAgent(actor, "state.init_force") : (actor || "system");
  return mutate({
    projectDir,
    request: operationRequest(isForce ? "state.init_force" : "state.init", resolvedActor, { force: isForce }),
    stateOperation: initOperation,
    policyAction,
    pluginId,
  });
}

/** Execute recovery restore through kernel.mutate. */
export async function restoreState({ projectDir, snapshotId, actor, policyAction, pluginId } = {}) {
  const resolvedActor = requireAgent(actor, "state.restore");
  return mutate({
    projectDir,
    request: operationRequest("state.restore", resolvedActor, { snapshot_id: snapshotId }),
    stateOperation: restoreOperation,
    policyAction,
    pluginId,
  });
}

export const stateInit = initState;
export const stateRestore = restoreState;
