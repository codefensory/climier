// init: create global state storage and repo-local project metadata.
// Always creates a v2 state. Passing `--v2` is rejected as an unknown
// flag by the CLI parser.
//
// When this command is about to overwrite an existing state file, it
// first captures a raw snapshot of the bytes under
// `<state-dir>/snapshots/`. The reason is `force-init` for an explicit
// `--force` reset and `corrupt-recovery` when a non-parseable file is
// recovered without `--force`. ADR-004 §§Snapshots/Plan 1.
//
// `--force` preserves the additive `plugins` field at the state root
// (ADR-005 §"Compatibilidad de estado v2": core mutators preserve the
// plugin keyspace). Per-node `plugins` lives inside `nodes[id]`; the
// force-init wipe intentionally removes the nodes, so per-node plugin
// data is wiped with them. The corrupt-recovery path cannot extract
// plugin data from a non-parseable state file, so it writes a clean
// `emptyState()` without `plugins`.
import fs from "node:fs/promises";
import { withLock } from "../lock.mjs";
import {
  stateFile,
  emptyState,
  writeState,
  ensureProjectMeta,
  readState,
  createSnapshot,
} from "../state.mjs";

export const knownFlags = ["force"];

export default async function init({ statePath, flags, projectDir }) {
  return withLock(projectDir, async () => {
    const existingFile = stateFile(projectDir);
    const exists = await fs.access(existingFile).then(() => true).catch(() => false);
    let snapshotReason = null;
    let preservedPlugins = null;
    if (exists && flags.force) {
      snapshotReason = "force-init";
      // Pre-extract root `plugins` so the wipe preserves them. We do
      // this BEFORE taking the snapshot so the read-then-write pair is
      // ordered under the same withLock; the snapshot itself is a raw
      // byte copy and doesn't need to be ordered against the read.
      // A corrupt or missing state file cannot yield plugin data; fall
      // back to fresh emptyState() in that case.
      let prev;
      try {
        prev = await readState(projectDir);
      } catch {
        prev = null;
      }
      if (
        prev &&
        prev.plugins &&
        typeof prev.plugins === "object" &&
        !Array.isArray(prev.plugins) &&
        Object.keys(prev.plugins).length > 0
      ) {
        preservedPlugins = prev.plugins;
      }
    } else if (exists) {
      // No --force and a file is present: check whether the existing
      // state is parseable. Two cases:
      //   - unsupported schema (v1) → rethrow (state.mjs owns the error).
      //   - corrupt / invalid JSON → overwrite without --force (recovery path).
      //   - valid state → refuse without --force.
      try {
        await readState(projectDir);
        throw new Error(`init: state file already exists at ${existingFile} (use --force to overwrite)`);
      } catch (e) {
        if (e.code === "CLIMIER_CORRUPT_STATE" || e instanceof SyntaxError) {
          // Corrupt state: overwrite without --force (recovery path).
          snapshotReason = "corrupt-recovery";
        } else {
          throw e;
        }
      }
    }
    // Snapshot under the same lock as the upcoming writeState. The lock
    // already serializes mutating operations on this project, so the
    // raw copy and the new write cannot interleave with another agent.
    if (snapshotReason) {
      await createSnapshot(projectDir, snapshotReason);
    }

    await ensureProjectMeta(projectDir);

    const fresh = emptyState();
    if (preservedPlugins) {
      // Add additive field only when there is data to preserve; an
      // empty `plugins` object would change the on-disk shape for
      // projects that never had plugin data, which is unnecessary.
      fresh.plugins = preservedPlugins;
    }
    await writeState(projectDir, fresh);
    return { ok: true, seeded: null, file: stateFile(projectDir) };
  });
}
