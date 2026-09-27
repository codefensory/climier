import fs from "node:fs/promises";
import path from "node:path";
import { assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import { detectMigrationState } from "./migrate-detection.mjs";
import { assertValidLedger } from "./ledger/recovery.mjs";
import { assertFencedMigrationSource, readJson } from "./ledger/stages.mjs";
import { commitFencedStateUnderLock } from "./ledger/commit.mjs";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";

function ledgerPath(statePath) {
  return path.join(path.dirname(statePath), "revision-ledger.json");
}

function hasPendingOperation(ledger) {
  return Boolean(ledger.migration_pending || ledger.commit_pending || ledger.bootstrap_pending
    || ledger.recovery_pending || ledger.replace_pending);
}

/** Commit the fenced-v5 to canonical-v1 schema transition under its project lock. */
export async function migrateFencedProjectUnderLock(lockContext, projectId) {
  assertActiveLockContext(lockContext);
  const { statePath } = getActiveLockContext(lockContext);
  const source = readJson(await fs.readFile(statePath, "utf8"), "state");
  const ledger = readJson(await fs.readFile(ledgerPath(statePath), "utf8"), "revision ledger");
  assertValidLedger(ledger);
  if (hasPendingOperation(ledger)) {
    const error = new Error(`migrate: project ${projectId} has a pending ledger operation`);
    error.code = "CLIMIER_LEDGER_PENDING_OPERATION";
    throw error;
  }

  const detection = detectMigrationState(source, { hasLedger: true });
  if (detection.error) throw new Error(`migrate: project ${projectId}: ${detection.error}`);
  if (detection.form === "canonical") {
    return { project_id: projectId, ...detection };
  }
  if (detection.form !== "fenced-legacy") {
    throw new Error(`migrate: project ${projectId} has unsupported form ${detection.form}`);
  }
  // The source is recognized by its v5 structure and matching ledger, not by
  // the global active fence marker: that marker may already have moved to v1.
  assertFencedMigrationSource(source, ledger);

  const candidate = {
    ...source,
    version: 1,
    revision: source.revision + 1,
    log: [...source.log, {
      ts: new Date().toISOString(),
      action: "migrate",
      agent: "migrate",
      from_version: 5,
      to_version: 1,
    }],
  };
  validateStateInvariants(candidate, "ledger.migrate.candidate");
  for (const [id, node] of Object.entries(source.nodes)) {
    if (candidate.nodes[id]?.revision !== node.revision) {
      throw new Error(`migrate: project ${projectId} schema transition changed node ${id} revision`);
    }
  }

  const committed = await commitFencedStateUnderLock(lockContext, candidate);
  return {
    project_id: projectId,
    ...detectMigrationState(committed, { hasLedger: true }),
    migrated: true,
  };
}
