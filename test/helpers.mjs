// Test helpers: isolated temp projects for each test.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const BIN = path.resolve(__dirname, "..", "bin", "climier.mjs");

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
  // we verify it points at a fresh temp dir or fail loudly.
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
// Default CLIMIER_AGENT for tests that exercise v2 mutating commands but
// don't pass --as. The new test file (v2-agent-source.test.mjs) deletes
// this env var to exercise the MISSING_AGENT path. v1 commands ignore it.
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

export function exampleState() {
  // v2 fixture. Tasks become nodes with subkind=task; decisions become gates;
  // gotchas become knowledge. Placeholders are kept via the placeholder flag.
  // blocked-by edges use the v2 BLOCKS shape (blocker -> blocked).
  return {
    version: 2,
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
}

export async function initExampleProject(dir, { force = false } = {}) {
  const args = ["--project", dir, "init"];
  if (force) args.push("--force");
  const r = await runCli(args);
  if (r.code !== 0) return r;
  await writeState(dir, exampleState());
  return r;
}

// Run the CLI as a child process. Returns { stdout, stderr, code }.
import { spawn } from "node:child_process";
export function runCli(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [BIN, ...args], {
      cwd,
      env: { ...process.env, ...(env || {}), NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// Import a src module fresh (bypass module cache between tests).
export async function importFresh(modulePath) {
  const url = new URL(modulePath, `file://${SRC_DIR}/`).href;
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

// ---- policy-fixture helpers (T-plugin-policy-fixture) ----------------
// installPolicyFixture / uninstallPolicyFixture wrap `climier install`
// and `climier uninstall` for the reusable V2-policy fixture at
// test/fixtures/plugins/policy-fixture/. Downstream suites
// (T-plugin-policy-seam-lifecycle, T-plugin-policy-seam-dag,
// T-plugin-policy-seam-state-ops, T-plugin-policy-migration-tests)
// use these to set up and tear down the policy fixture against an
// isolated CLIMIER_HOME without re-implementing the spawn dance.
//
// CLIMIER_HOME must already point at an isolated temp dir when these
// are called — helpers.mjs auto-creates one at load time, and
// per-test wrappers (e.g. withFreshEnv in plugin-core-e2e.test.mjs)
// set up their own. Helpers refuse to run against the real
// ~/.climier (see the guard at the top of this file).
const POLICY_FIXTURE_DIR = path.resolve(__dirname, "fixtures", "plugins", "policy-fixture");
const POLICY_FIXTURE_DEFAULT_ID = "policy-fixture";

// Custom-fixture cleanup: helpers create a per-call temp dir when a
// caller asks for a custom pluginId. We track those dirs in a Set
// and remove them on process exit so a SIGKILL leaves only the
// /tmp residue. Tests normally call `uninstallPolicyFixture` and
// the helper does the cleanup itself.
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
// copy of the reusable fixture with the new id baked into the
// descriptor and a self-contained entry that honors the supplied
// `appliesMode` / `authorizeMode` / `reason` options. We never
// mutate the original fixture directory in `test/fixtures/plugins/`
// because other suites share it.
//
// When `options.pluginId` is the default (or not provided), return
// the original fixture dir unchanged so the existing behavior is
// preserved exactly.
async function materializePolicyFixtureDir(options) {
  const pluginId =
    typeof options.pluginId === "string" && options.pluginId
      ? options.pluginId
      : POLICY_FIXTURE_DEFAULT_ID;

  if (pluginId === POLICY_FIXTURE_DEFAULT_ID) {
    return { fixtureDir: POLICY_FIXTURE_DIR, pluginId };
  }

  const customDir = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-custom-policy-"));
  trackCustomFixtureDir(customDir);

  // The installer's `predictInstalledPackageDir` (src/commands/install.mjs)
  // expects npm to drop the package at
  // `<staging>/node_modules/<path.basename(source)>/package.json`, where
  // `source` is the local path we pass to `climier install`. For npm to
  // honour that layout, the package.json `name` MUST match the directory
  // basename; otherwise npm installs under `node_modules/<pkg.name>/`
  // and the installer fails with PLUGIN_INVALID_DESCRIPTOR ("cannot read
  // package.json"). The descriptor id (`climier.id`) stays as
  // `pluginId` — that is the value the host uses for pluginId, the
  // installed-dir name, the data key and the uninstall argument.
  const pkgName = path.basename(customDir);

  // Build a fresh package.json with the caller-supplied plugin id.
  // We keep the rest of the descriptor identical to the reusable
  // fixture so the install / discover / dispatch path sees the same
  // shape; only `climier.id` changes (and that is what the loader
  // uses for `pluginId` and the installed dir name).
  const pkg = {
    name: pkgName,
    version: "1.0.0",
    description: `Custom policy fixture for ${pluginId} (T-plugin-policy-fixture helper)`,
    private: true,
    type: "module",
    climier: {
      id: pluginId,
      command: "policy",
      entry: "./climier.mjs",
      api: 3,
    },
  };
  await fsp.writeFile(
    path.join(customDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
    "utf8",
  );

  // Self-contained entry: applies/authorize read from
  // `<projectConfig>.plugins[pluginId]` only (mirroring the
  // fixture's `applies`/`authorize` contract — "el plugin solo lee
  // su propio namespace"). applies honors `appliesMode`:
  //   - "true"  → return true (namespace applies === true)
  //   - "false" → return false (namespace applies === false)
  //   - "throw" → throw a POLICY_ERROR_FIXTURE (mirrors the fixture's
  //               mode='throw' for applies, exercised by the
  //               adapter test that asserts POLICY_ERROR)
  // authorize honors `authorizeMode`:
  //   - "allow" | "abstain" | "deny" → return the canonical decision
  //   - "deny" carries `reason` (the helper writes the reason into
  //     `.climier.json` so the policy namespace is the single source
  //     of truth for the decision payload)
  const entry = `// Custom policy fixture entry — generated by
// test/helpers.mjs:installPolicyFixture when callers pass a custom
// pluginId. Reads its own namespace under
// \`<projectConfig>.plugins[${pluginId}]\` per ADR-007 §"Discovery
// global" (plugins only read their own namespace). Never imported
// from production code.

const PLUGIN_ID = ${JSON.stringify(pluginId)};

function applyNs(config) {
  if (!config || typeof config !== "object") return null;
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const ns = plugins[PLUGIN_ID];
  if (!ns || typeof ns !== "object") return null;
  return ns;
}

export async function applies(projectConfig) {
  const ns = applyNs(projectConfig);
  if (ns === null) return true;
  if (ns.applies === true) return true;
  if (ns.applies === false) return false;
  if (ns.appliesMode === "throw") {
    const err = new Error("policy-fixture: applies mode 'throw' rejected");
    err.code = "POLICY_ERROR_FIXTURE";
    throw err;
  }
  return true;
}

export async function authorize(ctx) {
  const ns = applyNs(ctx && ctx.projectConfig);
  const mode = ns && typeof ns.mode === "string" ? ns.mode : "allow";
  if (mode === "allow") return { decision: "allow" };
  if (mode === "deny") {
    const reason =
      ns && typeof ns.reason === "string" && ns.reason.length > 0
        ? ns.reason
        : "denied by policy-fixture";
    return { decision: "deny", reason };
  }
  if (mode === "abstain") return { decision: "abstain" };
  if (mode === "throw") {
    const err = new Error("policy-fixture: authorize mode 'throw' rejected the action");
    err.code = "POLICY_ERROR_FIXTURE";
    throw err;
  }
  return { decision: "allow" };
}

// default.commands is required by the descriptor loader
// (src/plugin-descriptor.mjs:132). The dynamic fixture is policy-only
// — no CLI subcommands — so an empty object is the correct shape.
// Without this, climier install raises PLUGIN_LOAD_FAILED
// ("entrypoint at <...> has no default.commands object") before
// npm even resolves the package; the test was masking that
// failure as an install error and never exercising the policy path.
export default {
  commands: {},
  policy: { applies, authorize },
};
`;
  await fsp.writeFile(path.join(customDir, "climier.mjs"), entry, "utf8");

  // Resolve the canonical (real) path before returning. mkdtemp
  // already returns a real path on Linux, but on platforms where
  // /tmp is a symlink (macOS `/tmp` -> `/private/tmp`) the basename
  // npm uses for `node_modules/<basename>/` could diverge from the
  // descriptor's `name` if the helper hands the child process an
  // un-resolved alias. fs.realpathSync makes the path canonical and
  // matches what install.predictInstalledPackageDir computes.
  const fixtureDir = fs.realpathSync(customDir);
  return { fixtureDir, pluginId };
}

// writePolicyNamespace — when callers pass any of the policy
// options below, materialize them into `.climier.json`'s
// `plugins[pluginId]` namespace so the fixture's
// `applies`/`authorize` reads them. `reason` is a JSON-stringified
// string (the helper's own contract); we JSON.parse it back to its
// raw form so the policy sees the same value the caller passed.
async function writePolicyNamespace(projectDir, pluginId, options) {
  const hasAny =
    options.appliesMode !== undefined ||
    options.authorizeMode !== undefined ||
    options.reason !== undefined;
  if (!hasAny) return;
  const metaPath = path.join(projectDir, ".climier.json");
  let config = {};
  try {
    config = JSON.parse(await fsp.readFile(metaPath, "utf8"));
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  config.plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
  const ns = { ...(config.plugins[pluginId] || {}) };
  if (options.appliesMode === "true") ns.applies = true;
  else if (options.appliesMode === "false") ns.applies = false;
  else if (options.appliesMode === "throw") ns.appliesMode = "throw";
  // appliesMode === "throw" is materialized by the custom entry's
  // applies() function (it reads ns.appliesMode directly); the helper
  // persists that signal under the same namespace so the policy
  // adapter sees it on every invocation.
  if (options.authorizeMode !== undefined) ns.mode = options.authorizeMode;
  if (options.reason !== undefined) {
    try {
      ns.reason = JSON.parse(options.reason);
    } catch {
      ns.reason = options.reason;
    }
  }
  config.plugins[pluginId] = ns;
  await fsp.writeFile(metaPath, JSON.stringify(config, null, 2) + "\n", "utf8");
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
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

export async function uninstallPolicyFixture(projectDir, options = {}) {
  // Resolve the uninstall id from `pluginId` (preferred — matches the
  // install helper's option name) or `id` (kept as a backward-
  // compatible alias for older callers).
  const id =
    typeof options.pluginId === "string" && options.pluginId
      ? options.pluginId
      : typeof options.id === "string" && options.id
      ? options.id
      : POLICY_FIXTURE_DEFAULT_ID;
  const args = ["--project", projectDir, "uninstall", id];
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `uninstallPolicyFixture: climier uninstall failed (exit ${result.code})\n` +
        `args: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

export { SRC_DIR, BIN, POLICY_FIXTURE_DIR };
