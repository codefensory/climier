import fs from "node:fs/promises";
import path from "node:path";
import { climierHome, projectMetaFile } from "../../storage/paths.ts";
import { detectMigrationState } from "../../storage/migrate-detection.ts";
import { withProjectIdLock } from "../../storage/lock.ts";
import { migrateProjectUnderLock } from "../../storage/migrate.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CliFlags, CommandContext } from "./contracts.ts";

type MigrationProject = { project_id: string; form: string; source_version: number | null; nodes: number; log_entries: number; error?: string; bootstrap_pending?: boolean; migration_pending?: boolean };

export const knownFlags = ["all", "dry-run"];

async function projectIdFor(projectDir: string, projectConfig: Record<string, unknown> = {}): Promise<string> {
  let metadata = projectConfig;
  if (typeof metadata.project_id !== "string" || !metadata.project_id.trim()) {
    try {
      metadata = JSON.parse(await fs.readFile(projectMetaFile(projectDir), "utf8"));
    } catch (caught) {
      const cause = asCaughtError(caught);
      const error = new Error(`migrate: cannot read project metadata at ${projectMetaFile(projectDir)}: ${cause.message}`);
      error.code = "CLIMIER_CORRUPT_PROJECT_META";
      error.cause = cause;
      throw error;
    }
  }
  if (!metadata || typeof metadata.project_id !== "string" || !metadata.project_id.trim()) {
    throw new Error(`migrate: project metadata at ${projectMetaFile(projectDir)} has no project_id`);
  }
  return metadata.project_id;
}

function reportFailure(projects: MigrationProject[]) {
  const affected = projects.filter(({ error }) => error).map(({ project_id }) => project_id);
  if (affected.length === 0) return;
  const error = new Error(`migrate: failed to inspect project(s): ${affected.join(", ")}`);
  error.code = "MIGRATION_REPORT_FAILED";
  error.details = { projects };
  throw error;
}

async function readProject(projectId: string): Promise<MigrationProject> {
  const projectPath = path.join(climierHome(), "projects", projectId);
  const statePath = path.join(projectPath, "tasks.json");
  let raw;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code === "ENOENT") {
      return { project_id: projectId, form: "empty", source_version: null, nodes: 0, log_entries: 0 };
    }
    throw error;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (caught) {
    const cause = asCaughtError(caught);
    return {
      project_id: projectId, form: "invalid", source_version: null, nodes: 0, log_entries: 0,
      error: `tasks.json is not valid JSON: ${cause.message}`,
    };
  }
  let hasLedger = false;
  try {
    await fs.access(path.join(projectPath, "revision-ledger.json"));
    hasLedger = true;
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code !== "ENOENT") throw error;
  }
  return { project_id: projectId, ...detectMigrationState(state, { hasLedger }) };
}

async function listProjectIds(): Promise<string[]> {
  const projectsDir = path.join(climierHome(), "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (caught) {
    const error = asCaughtError(caught);
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
}

export default async function migrate({ flags, projectDir, projectConfig }: CommandContext) {
  if (!projectDir) {
    const error = new Error("migrate: --project is required when invoking the command without a project root");
    error.code = "CLI_USAGE_ERROR";
    throw error;
  }
  if (flags.all && flags.project && path.resolve(flags.project as string) !== path.resolve(projectDir)) {
    const error = new Error("migrate: --all and --project cannot be used together");
    error.code = "CLI_USAGE_ERROR";
    throw error;
  }
  const all = flags.all === true || flags.all === "true";
  const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
  const ids = all ? await listProjectIds() : [await projectIdFor(projectDir, projectConfig)];
  const projects: MigrationProject[] = [];
  for (const projectId of ids) {
    try {
      if (dryRun) {
        // Do not create a transient lock file or any other bytes in dry-run.
        projects.push(await readProject(projectId));
      } else {

        projects.push(await withProjectIdLock(projectId, async (lockContext) => {
          const before = await readProject(projectId);
          let migrationLedger = null;
          try {
            migrationLedger = JSON.parse(await fs.readFile(path.join(climierHome(), "projects", projectId, "revision-ledger.json"), "utf8"));
          } catch (caught) {
            const error = asCaughtError(caught);
            if (error.code !== "ENOENT") throw error;
          }
          const ledger = migrationLedger as { bootstrap_pending?: boolean; migration_pending?: boolean } | null;
          const resumingBootstrap = Boolean(ledger?.bootstrap_pending);
          const oldMigrationPending = Boolean(ledger?.migration_pending);
          if (before.error && !resumingBootstrap && !oldMigrationPending) return before;
          const importableForm = resumingBootstrap || oldMigrationPending
            || ["pre-release", "legacy-v2", "legacy-v3", "legacy-v4", "fenced-legacy", "canonical", "empty"].includes(before.form);
          if (!importableForm || (before.error && !resumingBootstrap && !oldMigrationPending
              && !["pre-release", "legacy-v2", "legacy-v3", "legacy-v4"].includes(before.form))) return before;
          return migrateProjectUnderLock(lockContext, projectId);
        }));
      }
    } catch (caught) {
      const error = asCaughtError(caught);
      projects.push({
        project_id: projectId,
        form: "error",
        source_version: null,
        nodes: 0,
        log_entries: 0,
        error: error.message,
      });
    }
  }
  reportFailure(projects);
  return { projects };
}
