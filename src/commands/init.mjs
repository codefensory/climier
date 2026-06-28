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
      throw new Error(`init: state file already exists at ${file} (use --force to overwrite)`);
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
