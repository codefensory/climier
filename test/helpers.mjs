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
  return {
    version: 1,
    tasks: {
      "F0.T1": { id: "F0.T1", initiative: "migration", phase: "F0", title: "Create monorepo skeleton", skills: ["node"], effort: "s", domain: "monorepo" },
      "F0.T2": { id: "F0.T2", initiative: "migration", phase: "F0", title: "Scaffold API service with /health", depends_on: ["F0.T1"], skills: ["node", "http"], effort: "s", domain: "api" },
      "F0.T3": { id: "F0.T3", initiative: "migration", phase: "F0", title: "Add auth middleware compatible with current tokens", depends_on: ["F0.T2"], skills: ["ts", "auth"], effort: "m", domain: "auth" },
      "F0.T4": { id: "F0.T4", initiative: "migration", phase: "F0", title: "Create shared event schemas", depends_on: ["F0.T1"], skills: ["ts", "schema"], effort: "m", domain: "shared" },
      "F1.T1": { id: "F1.T1", initiative: "migration", phase: "F1", title: "Migrate one pilot endpoint with dual-write fallback", depends_on: ["F0.T3", "F0.T4"], skills: ["ts", "api"], effort: "m", domain: "api", acceptance: "New endpoint and legacy endpoint behave the same in staging for one week." },
      "F1.T2": { id: "F1.T2", initiative: "migration", phase: "F1", title: "Run end-to-end smoke test for the pilot flow", depends_on: ["F1.T1"], skills: ["ts", "e2e"], effort: "s", domain: "qa" },
      "F2.OPEN": { id: "F2.OPEN", initiative: "migration", phase: "F2", title: "Decompose F2: auth, catalog, and progress (resolve D4 first)", depends_on: ["F1.T2", "D4"], placeholder: true },
      "F3.OPEN": { id: "F3.OPEN", initiative: "migration", phase: "F3", title: "Decompose F3: data model and content migration (resolve D1 first)", depends_on: ["F2.OPEN", "D1"], placeholder: true },
      "F4.OPEN": { id: "F4.OPEN", initiative: "migration", phase: "F4", title: "Decompose F4: business workflows by domain", depends_on: ["F2.OPEN", "F3.OPEN"], placeholder: true },
      "F5.OPEN": { id: "F5.OPEN", initiative: "migration", phase: "F5", title: "Decompose F5: file handling and submissions (resolve D2 first)", depends_on: ["F4.OPEN", "D2"], placeholder: true },
      "F6.OPEN": { id: "F6.OPEN", initiative: "migration", phase: "F6", title: "Decompose F6: background jobs and async workers (resolve D3 first)", depends_on: ["F2.OPEN", "D3"], placeholder: true },
      "F7.OPEN": { id: "F7.OPEN", initiative: "migration", phase: "F7", title: "Decompose F7: integrations, notifications, and reporting", depends_on: ["F4.OPEN"], placeholder: true },
      "F8.OPEN": { id: "F8.OPEN", initiative: "migration", phase: "F8", title: "Decompose F8: frontend cutover", depends_on: ["F4.OPEN", "F5.OPEN", "F6.OPEN", "F7.OPEN"], placeholder: true },
      "F9.OPEN": { id: "F9.OPEN", initiative: "migration", phase: "F9", title: "Decompose F9: hardening, deploy, and cleanup", depends_on: ["F8.OPEN"], placeholder: true }
    },
    decisions: {
      D1: { id: "D1", title: "Data model migration strategy", applies_to: ["F3"] },
      D2: { id: "D2", title: "File storage target", applies_to: ["F5"] },
      D3: { id: "D3", title: "When to migrate background jobs", applies_to: ["F6"] },
      D4: { id: "D4", title: "Authentication migration strategy", applies_to: ["F2"] }
    },
    gotchas: {
      G1: { id: "G1", initiative: "migration", title: "Service-role access still needs app-level filters", applies_to: ["domain:db"], mitigation: "Filter by tenant or user in repositories, not only in the database." },
      G2: { id: "G2", initiative: "migration", title: "Dual-write endpoints need idempotency", applies_to: ["domain:api"], mitigation: "Use idempotency keys or dedupe guards before enabling retries." },
      G3: { id: "G3", initiative: "migration", title: "Session redirects break easily during auth swaps", applies_to: ["domain:auth"], mitigation: "Cover login, logout, expiry, and redirect flows with E2E checks." },
      G4: { id: "G4", initiative: "migration", title: "Storage migrations need stable object naming", applies_to: ["domain:storage"], mitigation: "Keep naming deterministic before copying or reindexing files." },
      G5: { id: "G5", initiative: "migration", title: "Background jobs need rate limits and replay safety", applies_to: ["domain:jobs"], mitigation: "Keep retry-safe handlers and verify rate limits before cutover." }
    },
    initiatives: {
      migration: { desc: "Example phased migration plan" }
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
export function runCli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [BIN, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
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

export { SRC_DIR, BIN };
