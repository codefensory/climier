// restore <snapshot-id> --as <agent>
//
// ADR-004 §§Commands/Plan 3: restore is the only restore path. It is a
// recovery primitive, not a labor action: no task claim lifecycle.
//
// ADR-008 §"restore e init --force" (T-plugin-policy-seam-state-ops):
// authority is no longer decided by comparing the actor against the
// `orchestrator`/`recovery` strings. The core only requires a non-empty
// actor (`--as` or CLIMIER_AGENT); the decision belongs to the policy
// seam, invoked INSIDE the lock with the canonical action
// `state.restore`. With no policy installed, or with `abstain`, the
// default core behaviour is to proceed.
//
// Contract:
//   - The snapshot must exist as a complete pair (raw + metadata) under
//     <state-dir>/snapshots/<id>.{json,meta.json}. Incomplete, missing,
//     metadata-id-mismatches-filename, or corrupt metadata → fail without
//     touching state.
//   - The raw bytes must parse as JSON v2 and carry every required
//     collection (nodes, edges, initiatives, log). v1, future versions,
//     missing fields, or unparseable raw → fail without touching state.
//   - The policy seam runs BEFORE any write, so a denied caller never
//     snapshots the pre-restore state (which would leak current state
//     into the snapshot dir as a side-effect of the failed call).
//   - Under withLock: validate target → authorize("state.restore") →
//     take a `pre-restore` snapshot of
//     the CURRENT state file → write the snapshot raw bytes to the state
//     path with tmp+rename → append a log entry `{ action: "restore",
//     agent, snapshot_id }` to the new state. The log append re-reads
//     the state we just wrote, so the entry lands in the restored log,
//     not the previous one.
//   - Returns `{ snapshot: <metadata> }` so callers can correlate the
//     restore with the file it came from.
//
// Error model: structured v2 errors via throwV2. The CLI entry emits
// them with code + details. We map:
//   - missing snapshot id → MISSING_FIELD
//   - missing/empty --as    → MISSING_AGENT
//   - policy deny           → POLICY_DENIED (policy throw → POLICY_ERROR)
//   - target absent / incomplete / corrupt → NODE_NOT_FOUND
//   - target wrong shape    → INVALID_STATUS
//
// The bin enforces knownFlags = ["as"], so unknown flags surface there.
import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "../lock.mjs";
import {
  stateFile,
  snapshotDir,
  createSnapshot,
  readState,
} from "../state.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["as"];

const REQUIRED_COLLECTIONS = ["nodes", "edges", "initiatives", "log"];

function snapshotPaths(projectDir, id) {
  const dir = snapshotDir(projectDir);
  return {
    dir,
    rawPath: path.join(dir, `${id}.json`),
    metaPath: path.join(dir, `${id}.meta.json`),
  };
}

function validateMetadataShape(meta, id) {
  if (!meta || typeof meta !== "object") {
    throwV2("NODE_NOT_FOUND", `restore: snapshot ${id} metadata is not an object`, { id });
  }
  if (meta.id !== id) {
    throwV2(
      "NODE_NOT_FOUND",
      `restore: snapshot ${id} metadata id does not match filename`,
      { id, metadata_id: meta.id },
    );
  }
}

function validateRawShape(rawBytes, id) {
  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (e) {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} raw is not valid JSON`,
      { id, error: e.message },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} raw is not a JSON object`,
      { id, kind: Array.isArray(parsed) ? "array" : typeof parsed },
    );
  }
  if (typeof parsed.version !== "number") {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} raw is missing a numeric version`,
      { id },
    );
  }
  if (parsed.version === 1) {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} is v1; v1 is no longer supported by this build`,
      { id, version: 1 },
    );
  }
  if (parsed.version > 2) {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} is version ${parsed.version}; this build only understands v2`,
      { id, version: parsed.version },
    );
  }
  // After version checks, v2 is the only legal shape.
  if (parsed.version !== 2) {
    throwV2(
      "INVALID_STATUS",
      `restore: snapshot ${id} has unsupported version ${parsed.version}`,
      { id, version: parsed.version },
    );
  }
  for (const k of REQUIRED_COLLECTIONS) {
    if (!(k in parsed)) {
      throwV2(
        "INVALID_STATUS",
        `restore: snapshot ${id} is missing '${k}' collection`,
        { id, missing: k },
      );
    }
  }
}

export default async function restore({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id || typeof id !== "string") {
    throwV2("MISSING_FIELD", "restore: snapshot id required", { field: "id" });
  }
  const projectDir = statePath;
  // resolveAgent throws MISSING_AGENT if --as is missing or empty,
  // surfacing the same code as every other mutating command. We do
  // NOT catch it: a missing --as is a missing flag, not an authority
  // violation, so MISSING_AGENT is the right diagnostic. The
  // authority gate below only fires when --as was supplied and is
  // some other non-empty value.
  const as = resolveAgent(flags, "restore");

  // Policy selection/import happens BEFORE the lock (ADR-007
  // §"Discovery global"; ADR-008 §"Seam por handler"). Only the
  // DECISION runs inside the lock, with the snapshot read there.
  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const { rawPath, metaPath } = snapshotPaths(projectDir, id);

    // Validate the snapshot's existence and metadata consistency before
    // reading the raw bytes (which are larger).
    let metaRaw;
    try {
      metaRaw = await fs.readFile(metaPath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        // Could be either "no metadata at all" or "metadata missing
        // because the pair is incomplete (raw exists, meta does not)".
        // We surface a NODE_NOT_FOUND either way; the caller sees the id.
        let rawExists = false;
        try {
          await fs.access(rawPath);
          rawExists = true;
        } catch {}
        throwV2(
          "NODE_NOT_FOUND",
          rawExists
            ? `restore: snapshot ${id} is incomplete (raw present, metadata missing)`
            : `restore: snapshot ${id} not found`,
          { id, raw_present: rawExists, meta_present: false },
        );
      }
      throw e;
    }
    let meta;
    try {
      meta = JSON.parse(metaRaw);
    } catch (e) {
      throwV2(
        "NODE_NOT_FOUND",
        `restore: snapshot ${id} metadata is corrupt`,
        { id, error: e.message },
      );
    }
    validateMetadataShape(meta, id);

    let rawBytes;
    try {
      rawBytes = await fs.readFile(rawPath);
    } catch (e) {
      if (e.code === "ENOENT") {
        throwV2(
          "NODE_NOT_FOUND",
          `restore: snapshot ${id} is incomplete (metadata present, raw missing)`,
          { id, raw_present: false, meta_present: true },
        );
      }
      throw e;
    }

    // All validation of the target must pass BEFORE we touch the state
    // file or the snapshot directory. We deliberately do not take the
    // pre-restore snapshot before this point so a bad target leaves no
    // trace in the snapshots dir.
    validateRawShape(rawBytes, id);

    // The current state file MUST exist for restore to capture a
    // pre-restore snapshot. If there is no live state, there is nothing
    // to displace, but also nothing to roll back to in case the restore
    // target is itself problematic. We surface a structured error and
    // leave the system untouched (no state file appears out of thin air).
    const statePathAbs = stateFile(projectDir);
    try {
      await fs.access(statePathAbs);
    } catch {
      throwV2(
        "INVALID_STATUS",
        `restore: no current state file at ${statePathAbs}; cannot pre-snapshot before restoring`,
        { id, state_file: statePathAbs },
      );
    }

    // ADR-008 §"restore e init --force": the authorization decision is
    // taken under the lock, against the CURRENT state, and BEFORE any
    // write. A deny/throw therefore leaves state and snapshots
    // untouched — no orphan `pre-restore` snapshot.
    //
    // The current state may be corrupt (restore is a recovery
    // primitive); a snapshot the policy can read is best-effort.
    let current = null;
    try {
      current = await readState(projectDir);
    } catch {
      current = null;
    }
    const decision = await authorizeAction({
      policy,
      action: "state.restore",
      actor: as,
      target: { id, kind: "snapshot", snapshot: meta },
      snapshot: {
        state: current,
        nodes: current && current.nodes ? { ...current.nodes } : {},
        edges: current && Array.isArray(current.edges) ? current.edges.slice() : [],
        initiatives: current && current.initiatives ? { ...current.initiatives } : {},
      },
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "state.restore",
        as,
        decision.reason || "denied by policy",
      );
    }
    // "allow" and "abstain" both proceed: with no policy installed the
    // default core rule is that any actor may restore (ADR-008 removed
    // the role hatch).

    // Pre-restore snapshot of the CURRENT state. Same lock, same atomic
    // primitives as init --force; a partial pair cannot appear because
    // createSnapshot uses temp+rename internally.
    await createSnapshot(projectDir, "pre-restore");

    // Replace the state file with the snapshot raw bytes verbatim via
    // tmp+rename. The rename is atomic on POSIX; on Windows, rename
    // across an existing destination is atomic-enough for the
    // "no half-written state file visible" contract.
    const tmpPath = `${statePathAbs}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, rawBytes);
    await fs.rename(tmpPath, statePathAbs);

    // Append a restore log entry to the NEW state. `append` re-reads the
    // file we just wrote, so the entry lands in the restored log —
    // meaning future `restore` calls would also see it if the user
    // re-restored the same snapshot.
    await append(projectDir, {
      agent: as,
      action: "restore",
      snapshot_id: id,
    });

    return { snapshot: meta };
  });
}