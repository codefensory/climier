import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTempProject, importFresh, readState, rmTempProject, installPolicyFixture, uninstallPolicyFixture } from "./helpers.mjs";

export { createTempProject, importFresh, readState, rmTempProject, installPolicyFixture, uninstallPolicyFixture };
export const fsModule = fs;
export const pathModule = path;
export const ADAPTER_MODULE = "../src/plugins/core-adapter.mjs";
export const REGISTRY_MODULE = "../src/plugins/core-registry.mjs";
export const EXPECTED_OPS = [
  "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel",
  "task.submit", "task.accept", "task.reject", "gate.create", "gate.update", "gate.resolve",
  "gate.reopen", "gate.cancel", "knowledge.create", "knowledge.update", "knowledge.deprecate",
  "edge.add", "edge.remove", "note.add", "initiative.create",
];

export async function withIsolatedEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-core-adapter-"));
  const prevHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  try {
    return await body();
  } finally {
    if (prevHome === undefined) { delete process.env.CLIMIER_HOME; }
    else { process.env.CLIMIER_HOME = prevHome; }
    await fs.rm(home, { recursive: true, force: true });
  }
}

export async function freshCore(projectDir, { agent = "alice", pluginId = "example.audit" } = {}) {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  await init({ statePath: projectDir, flags: { v2: true }, positional: [], projectDir });
  await addInit({ statePath: projectDir, flags: { desc: "plugin platform" }, positional: ["plugin-platform"] });
  const { createCore } = await importFresh(ADAPTER_MODULE);
  return createCore({ projectDir, agent, pluginId });
}

export const isUserNodeId = (id) => !id.startsWith("F");
export const isInvalidPluginCoreOperation = (err) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION";
export const isInputAsForbidden = (err) => err.code === "PLUGIN_CORE_INVALID_OPERATION" && err.details.reason === "input.as is forbidden";
export const isTaskUpdateMissingField = (err) => err && err.code === "PLUGIN_CORE_ACTION_FAILED" && err.details && err.details.op === "task.update" && err.details.cause && err.details.cause.code === "MISSING_FIELD";
export const isNoteAddMissingField = (err) => err && err.code === "PLUGIN_CORE_ACTION_FAILED" && err.details && err.details.op === "note.add" && err.details.cause && err.details.cause.code === "MISSING_FIELD";
export const isAuditPluginLogEntry = (entry) => entry.plugin_id === "example.audit";
export const isFirstCasNote = (note) => note.text === "first CAS note";
export const isPolicyDeniedTaskCreate = (err) => err && err.code === "POLICY_DENIED" && err.details && typeof err.details.reason === "string" && err.details.reason.includes("no task.creates") && err.details.action === "task.create" && err.details.plugin_id === "policy.test";
export const isPolicyTaskCreateError = (err) => err && err.code === "POLICY_ERROR" && err.details && err.details.action === "task.create";
