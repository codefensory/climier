// init: create global state storage and repo-local project metadata.
// v2-only. The previous `--v2` flag is gone; `init` always creates a v2
// state. Passing `--v2` is rejected as an unknown flag by the CLI parser.
import fs from "node:fs/promises";
import { withLock } from "../lock.mjs";
import { stateFile, emptyState, writeState, ensureProjectMeta, readState } from "../state.mjs";

export const knownFlags = ["force"];

export default async function init({ statePath, flags, projectDir }) {
  return withLock(projectDir, async () => {
    const existingFile = stateFile(projectDir);
    const exists = await fs.access(existingFile).then(() => true).catch(() => false);
    if (exists && !flags.force) {
      // Check the existing state. Three cases:
      //   - v1 → refuse without --force and guide the user to migrate.
      //   - corrupt / invalid JSON → allow overwrite without --force (recovery).
      //   - valid v2 → refuse without --force.
      try {
        await readState(projectDir);
        // Valid v2 state exists; refuse.
        throw new Error(`init: state file already exists at ${existingFile} (use --force to overwrite)`);
      } catch (e) {
        if (e.code === "STATE_V1_UNSUPPORTED") {
          // Surface the v1-unsupported error with explicit --force guidance.
          // Preserve the structured error code/details so the CLI entry
          // emits the rich shape.
          const wrapped = new Error(
            `init: existing state at ${existingFile} is v1; this version of climier no longer supports v1. ` +
            `Re-run with \`climier init --force\` to overwrite the v1 state with a fresh v2 state (this will erase the v1 data; back up first).`,
          );
          wrapped.code = "STATE_V1_UNSUPPORTED";
          wrapped.details = {
            ...(e.details || {}),
            hint: "Run `climier init --force` to overwrite the v1 state with a fresh v2 state.",
          };
          throw wrapped;
        }
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
