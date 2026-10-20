import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { asCaughtError } from "../../contracts/errors.ts";
import { readState, sqliteStateFile, stateFile } from "../state.ts";
import { stateBackend } from "../paths.ts";
import { withLock } from "../lock.ts";
import { readSqliteState, writeSqliteState } from "./store.ts";

async function ensureVerifiedBackup(file: string, backupFile: string, rawState: Buffer) {
  let handle;
  try {
    handle = await fs.open(backupFile, "wx", 0o600);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code !== "EEXIST") { throw error; }
  }
  if (handle) {
    try {
      await handle.writeFile(rawState);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const backup = await fs.readFile(backupFile);
  if (!backup.equals(rawState)) {
    throw new Error(`state migrate: backup at ${backupFile} does not match the JSON source at ${file}`);
  }
}

async function fileExists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return false; }
    throw error;
  }
}

async function validatedJsonSource(projectDir: string, jsonFile: string) {
  const state = await readState(projectDir);
  if (!state) { throw new Error(`state migrate: no canonical JSON state exists at ${jsonFile}`); }
  const raw = await fs.readFile(jsonFile);
  const verifiedState = await readState(projectDir);
  if (!isDeepStrictEqual(verifiedState, state) || !(await fs.readFile(jsonFile)).equals(raw)) {
    throw new Error(`state migrate: JSON source at ${jsonFile} changed while being validated`);
  }
  return { raw, state };
}

async function existingSqliteState(sqliteFile: string) {
  const exists = await fileExists(sqliteFile);
  const state = exists ? await readSqliteState(sqliteFile) : null;
  if (exists && state === null) {
    throw new Error(`state migrate: SQLite file at ${sqliteFile} contains no canonical state; refusing to overwrite it`);
  }
  return state;
}

function assertSqliteMatches(sqliteState: unknown, jsonState: unknown, sqliteFile: string) {
  if (!isDeepStrictEqual(sqliteState, jsonState)) {
    throw new Error(`state migrate: SQLite state at ${sqliteFile} differs from the JSON source; refusing to overwrite it`);
  }
}

export async function migrateJsonStateToSqlite(projectDir: string) {
  if (stateBackend() !== "json") {
    throw new Error("state migrate: set CLIMIER_STATE_BACKEND=json to migrate the canonical JSON source explicitly");
  }

  return withLock(projectDir, async () => {
    const jsonFile = stateFile(projectDir);
    const sqliteFile = sqliteStateFile(projectDir);
    const backupFile = `${jsonFile}.sqlite-backup`;
    const { raw, state } = await validatedJsonSource(projectDir, jsonFile);
    await ensureVerifiedBackup(jsonFile, backupFile, raw);
    const currentState = await existingSqliteState(sqliteFile);
    if (currentState !== null) {
      assertSqliteMatches(currentState, state, sqliteFile);
      return { migrated: false, backup: backupFile, database: sqliteFile };
    }

    await fs.mkdir(path.dirname(sqliteFile), { recursive: true });
    await writeSqliteState(sqliteFile, state);
    const migratedState = await readSqliteState(sqliteFile);
    assertSqliteMatches(migratedState, state, sqliteFile);
    return { migrated: true, backup: backupFile, database: sqliteFile };
  });
}
