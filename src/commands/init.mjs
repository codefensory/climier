// init: create .agents/tasks/tasks.json (empty or with a seed).
import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "../lock.mjs";
import { stateFile, emptyState, writeState } from "../state.mjs";
import { migrationSeed } from "../seeds/migration.mjs";

export default async function init({ statePath, flags, projectDir }) {
  return withLock(projectDir, async () => {
    const file = stateFile(projectDir);
    const exists = await fs.access(file).then(() => true).catch(() => false);
    if (exists && !flags.force) {
      // Check if the existing state is corrupt; if so, allow init without --force
      // to give a clean recovery path. Otherwise, require --force.
      try {
        const { readState } = await import("../state.mjs");
        await readState(projectDir);
        // Valid state exists; refuse.
        throw new Error(`init: state file already exists at ${file} (use --force to overwrite)`);
      } catch (e) {
        if (e.code === "CLIMIER_CORRUPT_STATE" || e instanceof SyntaxError) {
          // Corrupt state: log and overwrite without --force.
        } else {
          throw e;
        }
      }
    }

    await fs.mkdir(path.dirname(file), { recursive: true });

    let state;
    if (flags.seed === "migration") {
      state = migrationSeed;
    } else {
      state = emptyState();
    }
    await writeState(projectDir, state);
    return { ok: true, seeded: flags.seed || null, file };
  });
}
