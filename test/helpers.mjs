// Test helpers: isolated temp projects for each test.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN, runCli } from "./cli-harness.mjs";
import { withLock } from "../src/storage/lock.ts";
import {
  bootstrapFencedStateUnderLock,
  readFencedStateUnderLock,
  replaceFencedStateUnderLock,
} from "../src/storage/ledger.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(testDirectory, "..", "src");

// Plugin install fixtures go through the product's install command, which
// shells out to npm for one local-directory resolution. Real npm costs two
// extra node processes (~250ms) per install and the suite installs >100
// fixtures; the shim keeps that near zero. Tests that cover npm failures
// inject their own CLIMIER_NPM_CMD, and an operator-provided value always
// wins.
if (!process.env.CLIMIER_NPM_CMD && process.platform !== "win32") {
  process.env.CLIMIER_NPM_CMD = path.join(testDirectory, "fixtures", "npm-shim");
}

if (!process.env.CLIMIER_HOME) {
  process.env.CLIMIER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "climier-home-"));
  // Cleanup auto-created temp CLIMIER_HOME on exit. Real users set their
  // own CLIMIER_HOME and never hit this branch; the temp dir is owned by
  // us so deleting it is safe.
  process.on("exit", () => {
    try { fs.rmSync(process.env.CLIMIER_HOME, { recursive: true, force: true }); } catch {}
  });
} else {
  // Guard rail: a developer must NEVER run the suite against the real
  // ~/.climier. If CLIMIER_HOME is already set when helpers.mjs loads,

  // Acceptable paths:
  //   - <tmpdir>/climier-home-*      (auto-created by us in another process)
  //   - <tmpdir>/<anything>          (any other temp location)
  //   - explicitly safe prefixes     (CI runners set CLIMIER_HOME=/tmp/ci-climier)
  //
  // Refused paths:
  //   - ~/.climier
  //   - any non-tmpdir location that exists (we don't want to wipe personal data)
  const home = path.resolve(process.env.CLIMIER_HOME);
  const tmpRoot = path.resolve(os.tmpdir());
  const realUserHome = path.resolve(os.homedir(), ".climier");
  if (home === realUserHome || home.startsWith(realUserHome + path.sep)) {
    throw new Error(
      `helpers.mjs: refusing to run with CLIMIER_HOME=${realUserHome}. ` +
      `Tests would write to and potentially wipe the real global state. ` +
      `Unset CLIMIER_HOME so each run gets an isolated temp dir, or point it ` +
      `at an explicit temp location (e.g. CLIMIER_HOME=/tmp/climier-test).`
    );
  }
  if (!home.startsWith(tmpRoot + path.sep) && home !== tmpRoot) {
    throw new Error(
      `helpers.mjs: refusing to run with CLIMIER_HOME=${home}. ` +
      `It must live inside ${tmpRoot} to keep tests isolated. ` +
      `Unset CLIMIER_HOME so each run gets an isolated temp dir.`
    );
  }
}
// Default CLIMIER_AGENT for tests that exercise mutating commands but
// don't pass --as. test/agent-source.test.mjs deletes

if (!("CLIMIER_AGENT" in process.env)) {
  process.env.CLIMIER_AGENT = "test-agent";
}

function projectMetaPath(dir) {
  return path.join(dir, ".climier.json");
}

function defaultProjectId(dir) {
  return crypto.createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 16);
}

export function stateFilePath(dir) {
  const metaFile = projectMetaPath(dir);
  const projectId = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, "utf8")).project_id
    : defaultProjectId(dir);
  return path.join(process.env.CLIMIER_HOME, "projects", projectId, "tasks.json");
}

export function lockFilePath(dir) {
  return path.join(path.dirname(stateFilePath(dir)), ".lock");
}

export async function createTempProject() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "climier-test-"));
}

export async function rmTempProject(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function writeState(dir, state) {
  const file = stateFilePath(dir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Plant a fixture through the canonical ledger protocol. The input keeps the

// canonical-only there is no other writable form, and a fixture project must
// never claim a schema the reader refuses. The name retires with the era
// renames slice.
export async function writeFencedState(dir, state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 5) {
    throw new TypeError("writeFencedState: expected a v5 state fixture");
  }
  const { fence_generation: _fenceGeneration, ...content } = state;
  return writeCanonicalState(dir, content);
}

// Install a canonical fixture (version 1 plus its ledger) through the same
// protocol the product uses, so a fixture project is never inconsistent with

export async function writeCanonicalState(dir, state) {
  const initialState = {
    ...state,
    version: 4,
    revision: Number.isInteger(state.revision) ? state.revision : 0,
  };
  delete initialState.fence_generation;

  return withLock(dir, async (lockContext) => {
    const current = await readFencedStateUnderLock(lockContext);
    if (current) {
      return replaceFencedStateUnderLock(lockContext, {
        ...state,
        version: 1,
        fence_generation: current.fence_generation,
        revision: Number.isInteger(current.revision) ? current.revision : 0,
      });
    }
    return bootstrapFencedStateUnderLock(lockContext, initialState);
  });
}

export async function readState(dir) {
  const file = stateFilePath(dir);
  const raw = await fsp.readFile(file, "utf8");
  return JSON.parse(raw);
}

export async function stateExists(dir) {
  try {
    await fsp.access(stateFilePath(dir));
    return true;
  } catch {
    return false;
  }
}

// Canonical example fixture: tasks, gates, knowledge, placeholders, and BLOCKS edges.
const exampleStateFixture = {
  version: 1,
  nodes: {
    "F0.T1": { id: "F0.T1", kind: "resolvable", subkind: "task", title: "Create monorepo skeleton", initiative: "migration", domain: "monorepo", tags: ["node"], resolution_mode: "labor", status: "open", revision: 1 },
    "F0.T2": { id: "F0.T2", kind: "resolvable", subkind: "task", title: "Scaffold API service with /health", initiative: "migration", domain: "api", tags: ["node", "http"], resolution_mode: "labor", status: "open", revision: 1 },
    "F0.T3": { id: "F0.T3", kind: "resolvable", subkind: "task", title: "Add auth middleware compatible with current tokens", initiative: "migration", domain: "auth", tags: ["ts", "auth"], resolution_mode: "labor", status: "open", revision: 1 },
    "F0.T4": { id: "F0.T4", kind: "resolvable", subkind: "task", title: "Create shared event schemas", initiative: "migration", domain: "shared", tags: ["ts", "schema"], resolution_mode: "labor", status: "open", revision: 1 },
    "F1.T1": { id: "F1.T1", kind: "resolvable", subkind: "task", title: "Migrate one pilot endpoint with dual-write fallback", initiative: "migration", domain: "api", tags: ["ts", "api"], resolution_mode: "labor", status: "open", revision: 1, acceptance: "New endpoint and legacy endpoint behave the same in staging for one week." },
    "F1.T2": { id: "F1.T2", kind: "resolvable", subkind: "task", title: "Run end-to-end smoke test for the pilot flow", initiative: "migration", domain: "qa", tags: ["ts", "e2e"], resolution_mode: "labor", status: "open", revision: 1 },
    "F2.OPEN": { id: "F2.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F2: auth, catalog, and progress (resolve D4 first)", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F3.OPEN": { id: "F3.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F3: data model and content migration (resolve D1 first)", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F4.OPEN": { id: "F4.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F4: business workflows by domain", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F5.OPEN": { id: "F5.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F5: file handling and submissions (resolve D2 first)", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F6.OPEN": { id: "F6.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F6: background jobs and async workers (resolve D3 first)", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F7.OPEN": { id: "F7.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F7: integrations, notifications, and reporting", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F8.OPEN": { id: "F8.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F8: frontend cutover", initiative: "migration", status: "open", revision: 1, placeholder: true },
    "F9.OPEN": { id: "F9.OPEN", kind: "resolvable", subkind: "task", title: "Decompose F9: hardening, deploy, and cleanup", initiative: "migration", status: "open", revision: 1, placeholder: true },
    D1: { id: "D1", kind: "resolvable", subkind: "gate", title: "Data model migration strategy", initiative: "migration", status: "open", revision: 1, purpose: "decision" },
    D2: { id: "D2", kind: "resolvable", subkind: "gate", title: "File storage target", initiative: "migration", status: "open", revision: 1, purpose: "decision" },
    D3: { id: "D3", kind: "resolvable", subkind: "gate", title: "When to migrate background jobs", initiative: "migration", status: "open", revision: 1, purpose: "decision" },
    D4: { id: "D4", kind: "resolvable", subkind: "gate", title: "Authentication migration strategy", initiative: "migration", status: "open", revision: 1, purpose: "decision" },
    G1: { id: "G1", kind: "knowledge", title: "Service-role access still needs app-level filters", initiative: "migration", status: "active", knowledge_type: "warning", mitigation: "Filter by tenant or user in repositories, not only in the database.", scope: { domains: ["db"], initiatives: [], tags: [], node_ids: [] } },
    G2: { id: "G2", kind: "knowledge", title: "Dual-write endpoints need idempotency", initiative: "migration", status: "active", knowledge_type: "warning", mitigation: "Use idempotency keys or dedupe guards before enabling retries.", scope: { domains: ["api"], initiatives: [], tags: [], node_ids: [] } },
    G3: { id: "G3", kind: "knowledge", title: "Session redirects break easily during auth swaps", initiative: "migration", status: "active", knowledge_type: "warning", mitigation: "Cover login, logout, expiry, and redirect flows with E2E checks.", scope: { domains: ["auth"], initiatives: [], tags: [], node_ids: [] } },
    G4: { id: "G4", kind: "knowledge", title: "Storage migrations need stable object naming", initiative: "migration", status: "active", knowledge_type: "warning", mitigation: "Keep naming deterministic before copying or reindexing files.", scope: { domains: ["storage"], initiatives: [], tags: [], node_ids: [] } },
    G5: { id: "G5", kind: "knowledge", title: "Background jobs need rate limits and replay safety", initiative: "migration", status: "active", knowledge_type: "warning", mitigation: "Keep retry-safe handlers and verify rate limits before cutover.", scope: { domains: ["jobs"], initiatives: [], tags: [], node_ids: [] } },
  },
  edges: [
    { from: "F0.T1", to: "F0.T2", type: "BLOCKS" },
    { from: "F0.T2", to: "F0.T3", type: "BLOCKS" },
    { from: "F0.T1", to: "F0.T4", type: "BLOCKS" },
    { from: "F0.T3", to: "F1.T1", type: "BLOCKS" },
    { from: "F0.T4", to: "F1.T1", type: "BLOCKS" },
    { from: "F1.T1", to: "F1.T2", type: "BLOCKS" },
    { from: "F1.T2", to: "F2.OPEN", type: "BLOCKS" },
    { from: "F2.OPEN", to: "F3.OPEN", type: "BLOCKS" },
    { from: "F2.OPEN", to: "F4.OPEN", type: "BLOCKS" },
    { from: "F4.OPEN", to: "F5.OPEN", type: "BLOCKS" },
    { from: "F2.OPEN", to: "F6.OPEN", type: "BLOCKS" },
    { from: "F4.OPEN", to: "F7.OPEN", type: "BLOCKS" },
    { from: "F4.OPEN", to: "F8.OPEN", type: "BLOCKS" },
    { from: "F5.OPEN", to: "F8.OPEN", type: "BLOCKS" },
    { from: "F6.OPEN", to: "F8.OPEN", type: "BLOCKS" },
    { from: "F7.OPEN", to: "F8.OPEN", type: "BLOCKS" },
    { from: "F8.OPEN", to: "F9.OPEN", type: "BLOCKS" },
    { from: "D4", to: "F2.OPEN", type: "BLOCKS" },
    { from: "D1", to: "F3.OPEN", type: "BLOCKS" },
    { from: "D2", to: "F5.OPEN", type: "BLOCKS" },
    { from: "D3", to: "F6.OPEN", type: "BLOCKS" },
  ],
  initiatives: {
    migration: { desc: "Example phased migration plan", created_at: "2024-01-01T00:00:00.000Z" },
  },
  log: [],
};

export function exampleState() {
  return structuredClone(exampleStateFixture);
}

export async function initExampleProject(dir, { force = false } = {}) {
  const args = ["--project", dir, "init"];
  if (force) {
    args.push("--force");
  }
  const r = await runCli(args);
  if (r.code !== 0) {
    return r;
  }
  await writeCanonicalState(dir, exampleState());
  return r;
}

// The CLI harness (in-process by default, runCliSpawn for process isolation)
// lives in cli-harness.mjs and is re-exported here for the test corpus.

export function importFresh(modulePath) {
  const url = new URL(modulePath, `file://${SRC_DIR}/`).href;
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

// Shared plugin policy fixture for downstream test suites.
const POLICY_FIXTURE_DIR = path.resolve(testDirectory, "fixtures", "plugins", "policy-fixture");
const POLICY_FIXTURE_DEFAULT_ID = "policy-fixture";

const customFixtureDirs = new Set();

function trackCustomFixtureDir(dir) {
  customFixtureDirs.add(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of customFixtureDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// materializePolicyFixtureDir — when the caller supplies a custom
// `pluginId` (or any of the option fields below), build a per-call
// copy of the reusable fixture. Never mutate the shared fixture.
async function materializePolicyFixtureDir(options) {
  const pluginId = typeof options.pluginId === "string" && options.pluginId
    ? options.pluginId
    : POLICY_FIXTURE_DEFAULT_ID;
  if (pluginId === POLICY_FIXTURE_DEFAULT_ID) {
    return { fixtureDir: POLICY_FIXTURE_DIR, pluginId };
  }

  const customDir = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-custom-policy-"));
  trackCustomFixtureDir(customDir);
  await writeCustomPolicyFixture(customDir, pluginId);
  const fixtureDir = fs.realpathSync(customDir);
  return { fixtureDir, pluginId };
}

async function writeCustomPolicyFixture(customDir, pluginId) {
  await writeCustomPolicyPackage(customDir, pluginId);
  await fsp.writeFile(path.join(customDir, "climier.mjs"), buildPolicyFixtureEntry(pluginId), "utf8");
}

async function writeCustomPolicyPackage(customDir, pluginId) {
  const pkgName = path.basename(customDir);
  const pkg = {
    name: pkgName,
    version: "1.0.0",
    description: `Custom policy fixture for ${pluginId} (T-plugin-policy-fixture helper)`,
    private: true,
    type: "module",
    climier: { id: pluginId, command: "policy", entry: "./climier.mjs", api: 1 },
  };
  await fsp.writeFile(path.join(customDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function buildPolicyFixtureEntry(pluginId) {
  return [
    policyFixtureEntryHeader(pluginId),
    policyFixtureApplyNsSource(),
    policyFixtureAppliesSource(),
    policyFixtureAuthorizeSource(),
    policyFixtureExportSource(),
  ].join("\n");
}

function policyFixtureEntryHeader(pluginId) {
  return `const PLUGIN_ID = ${JSON.stringify(pluginId)};`;
}

function policyFixtureApplyNsSource() {
  return `function applyNs(config) { if (!config || typeof config !== "object") return null; const plugins = config.plugins; if (!plugins || typeof plugins !== "object") return null; const ns = plugins[PLUGIN_ID]; return ns && typeof ns === "object" ? ns : null; }`;
}

function policyFixtureAppliesSource() {
  return `export async function applies(projectConfig) { const ns = applyNs(projectConfig); if (ns === null || ns.applies === true) return true; if (ns.applies === false) return false; if (ns.appliesMode === "throw") { const err = new Error("policy-fixture: applies mode 'throw' rejected"); err.code = "POLICY_ERROR_FIXTURE"; throw err; } return true; }`;
}

function policyFixtureAuthorizeSource() {
  return `export async function authorize(ctx) { const ns = applyNs(ctx && ctx.projectConfig); const mode = ns && typeof ns.mode === "string" ? ns.mode : "allow"; if (mode === "allow") return { decision: "allow" }; if (mode === "deny") return { decision: "deny", reason: ns && typeof ns.reason === "string" && ns.reason.length > 0 ? ns.reason : "denied by policy-fixture" }; if (mode === "abstain") return { decision: "abstain" }; if (mode === "throw") { const err = new Error("policy-fixture: authorize mode 'throw' rejected the action"); err.code = "POLICY_ERROR_FIXTURE"; throw err; } return { decision: "allow" }; }`;
}

function policyFixtureExportSource() {
  return `export default { commands: {}, policy: { applies, authorize } };`;
}

async function writePolicyNamespace(projectDir, pluginId, options) {
  if (!hasPolicyOptions(options)) {
    return;
  }
  const metaPath = path.join(projectDir, ".climier.json");
  const config = await readProjectConfig(metaPath);
  config.plugins = getPluginNamespaces(config.plugins);
  const ns = { ...config.plugins[pluginId] };
  setAppliesMode(ns, options.appliesMode);
  // appliesMode === "throw" is materialized by the custom entry's
  // applies() function (it reads ns.appliesMode directly); the helper
  // persists that signal under the same namespace so the policy
  // adapter sees it on every invocation.
  if (options.authorizeMode !== undefined) {
    ns.mode = options.authorizeMode;
  }
  if (options.reason !== undefined) {
    ns.reason = parseReason(options.reason);
  }
  config.plugins[pluginId] = ns;
  await fsp.writeFile(metaPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function hasPolicyOptions(options) {
  return options.appliesMode !== undefined || options.authorizeMode !== undefined || options.reason !== undefined;
}

async function readProjectConfig(metaPath) {
  try {
    return JSON.parse(await fsp.readFile(metaPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

function getPluginNamespaces(plugins) {
  return plugins && typeof plugins === "object" ? plugins : {};
}

function setAppliesMode(namespace, mode) {
  if (mode === "true") {
    namespace.applies = true;
  } else if (mode === "false") {
    namespace.applies = false;
  } else if (mode === "throw") {
    namespace.appliesMode = "throw";
  }
}

function parseReason(reason) {
  try {
    return JSON.parse(reason);
  } catch {
    return reason;
  }
}

export async function installPolicyFixture(projectDir, options = {}) {
  const { fixtureDir, pluginId } = await materializePolicyFixtureDir(options);
  await writePolicyNamespace(projectDir, pluginId, options);
  const args = ["--project", projectDir, "install", fixtureDir];
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `installPolicyFixture: climier install failed (exit ${result.code})\n` +
        `args: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

export async function uninstallPolicyFixture(projectDir, options = {}) {

  // install helper's option name) or `id` (kept as a backward-
  // compatible alias for older callers).
  let id = POLICY_FIXTURE_DEFAULT_ID;
  if (typeof options.id === "string" && options.id) {
    id = options.id;
  }
  if (typeof options.pluginId === "string" && options.pluginId) {
    id = options.pluginId;
  }
  const args = ["--project", projectDir, "uninstall", id];
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `uninstallPolicyFixture: climier uninstall failed (exit ${result.code})\n` +
        `args: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

export { SRC_DIR, BIN, POLICY_FIXTURE_DIR };
export { runCli, runCliInProcess, runCliSpawn } from "./cli-harness.mjs";
