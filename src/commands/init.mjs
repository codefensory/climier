// init: create global state storage and repo-local project metadata.
// Always creates a v2 state. Passing `--v2` is rejected as an unknown
// flag by the CLI parser.
//
// When this command is about to overwrite an existing state file, it
// first captures a raw snapshot of the bytes under
// `<state-dir>/snapshots/`. The reason is `force-init` for an explicit
// `--force` reset and `corrupt-recovery` when a non-parseable file is
// recovered without `--force`. ADR-004 §§Snapshots/Plan 1.
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
    if (exists && flags.force) {
      snapshotReason = "force-init";
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

    await writeState(projectDir, emptyState());
    return { ok: true, seeded: null, file: stateFile(projectDir) };
  });
}
