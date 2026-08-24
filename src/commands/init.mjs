// init: create global state storage and repo-local project metadata.
// Always creates a v2 state. Passing `--v2` is rejected as an unknown
// flag by the CLI parser.
import fs from "node:fs/promises";
import { withLock } from "../lock.mjs";
import { stateFile, emptyState, writeState, ensureProjectMeta, readState } from "../state.mjs";

export const knownFlags = ["force"];

export default async function init({ statePath, flags, projectDir }) {
  return withLock(projectDir, async () => {
    const existingFile = stateFile(projectDir);
    const exists = await fs.access(existingFile).then(() => true).catch(() => false);
    if (exists && !flags.force) {
      // Check the existing state. Two cases:
      //   - unsupported state schema → rethrow (state.mjs owns the error).
      //   - corrupt / invalid JSON → allow overwrite without --force (recovery).
      //   - valid state → refuse without --force.
      try {
        await readState(projectDir);
        throw new Error(`init: state file already exists at ${existingFile} (use --force to overwrite)`);
      } catch (e) {
        if (e.code === "CLIMIER_CORRUPT_STATE" || e instanceof SyntaxError) {
          // Corrupt state: overwrite without --force (recovery path).
        } else {
          throw e;
        }
      }
    }

    await ensureProjectMeta(projectDir);

    await writeState(projectDir, emptyState());
    return { ok: true, seeded: null, file: stateFile(projectDir) };
  });
}
