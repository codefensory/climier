// init: create .agents/tasks/tasks.json (empty or with a seed).
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, emptyState, readState, writeState } from "../state.mjs";
import { migrationSeed } from "../seeds/migration.mjs";

export default async function init({ statePath, flags, projectDir }) {
  const file = stateFile(projectDir);
  const exists = await fs.access(file).then(() => true).catch(() => false);
  if (exists) throw new Error(`init: state file already exists at ${file} (won't overwrite; delete it first or use a different --project)`);

  await fs.mkdir(path.dirname(file), { recursive: true });

  let state;
  if (flags.seed === "migration") {
    state = migrationSeed;
  } else {
    state = emptyState();
  }
  await writeState(projectDir, state);
  return { ok: true, seeded: flags.seed || null, file };
}
