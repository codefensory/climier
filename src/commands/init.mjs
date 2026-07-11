// init: create global state storage and repo-local project metadata.
import fs from "node:fs/promises";
import { withLock } from "../lock.mjs";
import { legacyStateFile, projectMetaFile } from "../paths.mjs";
import { stateFile, emptyState, writeState, ensureProjectMeta } from "../state.mjs";
import { migrationSeed } from "../seeds/migration.mjs";

export const knownFlags = ["seed", "force"];

export default async function init({ statePath, flags, projectDir }) {
  return withLock(projectDir, async () => {
    const legacyFile = legacyStateFile(projectDir);
    const hadMeta = await fs.access(projectMetaFile(projectDir)).then(() => true).catch(() => false);
    const existingFile = hadMeta ? stateFile(projectDir) : legacyFile;
    const exists = await fs.access(existingFile).then(() => true).catch(() => false);
    if (exists && !flags.force) {
      // Check if the existing state is corrupt; if so, allow init without --force
      // to give a clean recovery path. Otherwise, require --force.
      try {
        const { readState } = await import("../state.mjs");
        await readState(projectDir);
        // Valid state exists; refuse.
        throw new Error(`init: state file already exists at ${existingFile} (use --force to overwrite)`);
      } catch (e) {
        if (e.code === "CLIMIER_CORRUPT_STATE" || e instanceof SyntaxError) {
          // Corrupt state: overwrite without --force.
        } else {
          throw e;
        }
      }
    }

    await ensureProjectMeta(projectDir);

    let state;
    if (flags.seed === "migration") {
      state = migrationSeed;
    } else {
      state = emptyState();
    }
    await writeState(projectDir, state);
    return { ok: true, seeded: flags.seed || null, file: stateFile(projectDir) };
  });
}
