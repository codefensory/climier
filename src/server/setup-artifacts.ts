/* eslint-disable complexity, max-statements, max-lines-per-function */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { parseServerRuntimeConfig } from "./runtime-config.ts";
import { renderSystemdUnit } from "./systemd-unit.ts";
import type { Distribution } from "../upgrade/distribution.ts";
import { errorProperties, type ServerError } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43_127;
const DEFAULT_UNIT = "climier-server.service";
const PASSWORD_BYTES = 32;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ArtifactAction = "create" | "none" | "conflict";

export type SetupOptions = {
  root: string;
  listen?: { host: string; port: number };
  host?: string;
  port?: number;
  dataRoot?: string;
  stateHome?: string;
  uiRoot?: string;
  serviceUser?: string;
  invokerUser?: string;
  unit?: "systemd" | "none";
  serviceName?: string;
  maxBodyBytes?: number;
  allowMissingPaths?: boolean;
  dryRun?: boolean;
  force?: boolean;
  rotatePassword?: boolean;
  printSecret?: boolean;
  distribution?: Distribution;
  modulePath?: string;
  runtimePath?: string;
};

export type SetupResult = {
  ok: true;
  root: string;
  changed: boolean;
  created: string[];
  files: { config: string; env: string; unit: string | null };
  listen: { host: string; port: number };
  secret: { written: boolean; printed: boolean; value?: string };
  actions?: Array<{ path: string; action: ArtifactAction }>;
  pending: string[];
  warnings: string[];
  next: string[];
};

type ExistingArtifact = { exists: boolean; content?: string; regular: boolean; mode?: number };

function setupError(code: string, message: string, details?: unknown): ServerError {
  const error = Object.assign(new Error(`server setup: ${message}`), { code }) as ServerError;
  if (details && typeof details === "object") { error.details = details as Record<string, unknown>; }
  return error;
}

function absoluteOption(value: string | undefined, fallback: string, name: string): string {
  const result = path.resolve(value ?? fallback);
  if (typeof value !== "undefined" && (!path.isAbsolute(value) || value.length === 0)) {
    throw setupError("INVALID_SERVER_SETUP", `${name} must be an absolute path`);
  }
  return result;
}

async function readArtifact(file: string): Promise<ExistingArtifact> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) { return { exists: true, regular: false }; }
    return { exists: true, regular: true, mode: info.mode & 0o777, content: await fs.readFile(file, "utf8") };
  } catch (error) {
    if (errorProperties(error).code === "ENOENT") { return { exists: false, regular: false }; }
    throw error;
  }
}

function sameConfig(left: unknown, right: unknown): boolean {
  try {
    const a = parseServerRuntimeConfig(left);
    const b = parseServerRuntimeConfig(right);
    return a.listen.host === b.listen.host
      && a.listen.port === b.listen.port
      && a.dataRoot === b.dataRoot
      && a.stateHome === b.stateHome
      && a.uiRoot === b.uiRoot;
  } catch {
    return false;
  }
}

type ParsedEnvironment = { password: string; maxBodyBytes?: number; lines: string[] };

function parseEnvironment(content: string | undefined): ParsedEnvironment | null {
  if (content === undefined) { return null; }
  const lines = content.split(/\r?\n/u).filter(Boolean);
  let password: string | undefined;
  let maxBodyBytes: number | undefined;
  for (const line of lines) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!assignment) { return null; }
    if (assignment[1] === "CLIMIER_SERVER_PASSWORD") {
      if (password !== undefined || !PASSWORD_PATTERN.test(assignment[2])) { return null; }
      if (Buffer.from(assignment[2], "base64url").byteLength !== PASSWORD_BYTES) { return null; }
      password = assignment[2];
    } else if (assignment[1] === "CLIMIER_SERVER_MAX_BODY_BYTES") {
      if (maxBodyBytes !== undefined || !/^\d+$/u.test(assignment[2])) { return null; }
      maxBodyBytes = Number(assignment[2]);
    }
  }
  return password === undefined ? null : { password, maxBodyBytes, lines };
}

function environmentText(password: string, maxBodyBytes?: number, existing?: ParsedEnvironment | null): string {
  const lines = existing ? [...existing.lines] : [`CLIMIER_SERVER_PASSWORD=${password}`];
  const passwordIndex = lines.findIndex((line) => line.startsWith("CLIMIER_SERVER_PASSWORD="));
  if (passwordIndex === -1) {
    lines.unshift(`CLIMIER_SERVER_PASSWORD=${password}`);
  } else {
    lines[passwordIndex] = `CLIMIER_SERVER_PASSWORD=${password}`;
  }
  if (maxBodyBytes !== undefined) {
    const maxIndex = lines.findIndex((line) => line.startsWith("CLIMIER_SERVER_MAX_BODY_BYTES="));
    if (maxIndex === -1) {
      lines.push(`CLIMIER_SERVER_MAX_BODY_BYTES=${maxBodyBytes}`);
    } else {
      lines[maxIndex] = `CLIMIER_SERVER_MAX_BODY_BYTES=${maxBodyBytes}`;
    }
  }
  return `${lines.join("\n")}\n`;
}

function createTemporaryName(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
}

async function writeAtomically(file: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = createTemporaryName(file);
  try {
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function actionFor(artifact: ExistingArtifact, matches: boolean, force: boolean): ArtifactAction {
  if (!artifact.exists) { return "create"; }
  if (artifact.regular && matches) { return "none"; }
  return force ? "create" : "conflict";
}

function currentUser(): string | undefined {
  if (typeof process.getuid === "function" && process.getuid() === 0) { return "root"; }
  return process.env.USER || process.env.LOGNAME;
}

function ownershipCommands({ root, dataRoot, stateHome, serviceUser, invokerUser }: { root: string; dataRoot: string; stateHome: string; serviceUser?: string; invokerUser?: string }) {
  if (!serviceUser || serviceUser === (invokerUser ?? currentUser())) { return []; }
  return [
    `chown -R ${serviceUser}:${serviceUser} ${dataRoot} ${stateHome}`,
    `chown ${serviceUser}:${serviceUser} ${path.join(root, "server.json")} ${path.join(root, "server.env")}`,
    `chmod 700 ${dataRoot} ${stateHome}`,
    `chmod 600 ${path.join(root, "server.json")} ${path.join(root, "server.env")}`,
  ];
}

function setupWarnings(serviceUser?: string, invokerUser?: string): string[] {
  const warnings: string[] = [];
  const runningAsRoot = invokerUser === "root"
    || (typeof process.getuid === "function" && process.getuid() === 0);
  if (runningAsRoot) {
    warnings.push("running as root; verify service ownership before starting systemd");
  }
  if (serviceUser && serviceUser === "root") {
    warnings.push("service user is root; systemd hardening does not reduce service identity privileges");
  }
  return warnings;
}

function validateOptions(options: SetupOptions) {
  if (!options || typeof options.root !== "string" || options.root.length === 0) {
    throw setupError("INVALID_SERVER_SETUP", "root is required");
  }
  const unit = options.unit ?? "systemd";
  if (unit !== "systemd" && unit !== "none") { throw setupError("INVALID_SERVER_SETUP", "unit must be systemd or none"); }
  if (options.serviceName !== undefined && !/^\S+\.service$/u.test(options.serviceName)) {
    throw setupError("INVALID_SERVER_SETUP", "serviceName must end with .service and contain no whitespace");
  }
  if (options.serviceUser !== undefined && !/^\S+$/u.test(options.serviceUser)) {
    throw setupError("INVALID_SERVER_SETUP", "serviceUser must be a non-empty name without whitespace");
  }
  if (options.maxBodyBytes !== undefined && (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1 || options.maxBodyBytes > 33_554_432)) {
    throw setupError("INVALID_SERVER_SETUP", "maxBodyBytes must be between 1 and 33554432");
  }
  return unit;
}

export async function generateServerArtifacts(options: SetupOptions): Promise<SetupResult> {
  const unitMode = validateOptions(options);
  const root = path.resolve(options.root);
  const dataRoot = absoluteOption(options.dataRoot, path.join(root, "data"), "dataRoot");
  const stateHome = absoluteOption(options.stateHome, path.join(root, "state"), "stateHome");
  const uiRoot = options.uiRoot === undefined ? undefined : absoluteOption(options.uiRoot, options.uiRoot, "uiRoot");
  const host = options.listen?.host ?? options.host ?? DEFAULT_HOST;
  const port = options.listen?.port ?? options.port ?? DEFAULT_PORT;
  const config = parseServerRuntimeConfig({
    listen: { host, port },
    dataRoot,
    stateHome,
    ...(uiRoot === undefined ? {} : { uiRoot }),
  });
  const configPath = path.join(root, "server.json");
  const envPath = path.join(root, "server.env");
  const unitPath = unitMode === "systemd" ? path.join(root, options.serviceName ?? DEFAULT_UNIT) : null;
  const configArtifact = await readArtifact(configPath);
  const envArtifact = await readArtifact(envPath);
  const unitArtifact = unitPath ? await readArtifact(unitPath) : { exists: false, regular: false };

  const existingEnvironment = parseEnvironment(envArtifact.content);
  const configMatches = Boolean(configArtifact.regular && configArtifact.mode === 0o600 && (() => {
    try { return sameConfig(JSON.parse(configArtifact.content ?? ""), config); } catch { return false; }
  })());
  const expectedUnit = unitPath ? renderSystemdUnit({
    root,
    dataRoot,
    stateHome,
    serviceUser: options.serviceUser,
    distribution: options.distribution,
    modulePath: options.modulePath,
    runtimePath: options.runtimePath,
  }) : undefined;
  const unitMatches = Boolean(unitPath && unitArtifact.regular && unitArtifact.mode === 0o600
    && unitArtifact.content === expectedUnit);
  const envMatches = Boolean(envArtifact.regular && envArtifact.mode === 0o600 && existingEnvironment !== null
    && (options.maxBodyBytes === undefined || existingEnvironment.maxBodyBytes === options.maxBodyBytes));
  const configAction = actionFor(configArtifact, configMatches, options.force === true);
  let envAction: ArtifactAction;
  if (options.rotatePassword) {
    envAction = envArtifact.exists && !envArtifact.regular && !options.force ? "conflict" : "create";
  } else {
    envAction = actionFor(envArtifact, envMatches, options.force === true);
  }
  const unitAction = unitPath ? actionFor(unitArtifact, unitMatches, options.force === true) : undefined;
  const actions = [
    { path: configPath, action: configAction },
    { path: envPath, action: envAction },
    ...(unitPath && unitAction ? [{ path: unitPath, action: unitAction }] : []),
  ];
  const conflicts = actions.filter(({ action }) => action === "conflict");
  if (conflicts.length > 0 && !options.dryRun) {
    throw setupError("SERVER_CONFIG_EXISTS", "existing server setup conflicts with requested options", {
      paths: conflicts.map(({ path: file }) => file),
    });
  }

  const password = options.rotatePassword || !existingEnvironment
    ? randomBytes(PASSWORD_BYTES).toString("base64url")
    : existingEnvironment.password;
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const envText = environmentText(password, options.maxBodyBytes, existingEnvironment);
  const created = options.dryRun ? [] : actions.filter(({ action }) => action === "create").map(({ path: file }) => path.basename(file));
  if (!options.dryRun) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (!options.allowMissingPaths) {
      await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(stateHome, { recursive: true, mode: 0o700 });
    }
    if (configAction === "create") { await writeAtomically(configPath, configText); }
    if (envAction === "create") { await writeAtomically(envPath, envText); }
    if (unitPath && unitAction === "create") { await writeAtomically(unitPath, expectedUnit!, 0o600); }
  }

  const changed = !options.dryRun && created.length > 0;
  const pending = ownershipCommands({ root, dataRoot, stateHome, serviceUser: options.serviceUser, invokerUser: options.invokerUser });
  const warnings = setupWarnings(options.serviceUser, options.invokerUser);
  if (options.allowMissingPaths) { warnings.push("dataRoot and stateHome existence deferred by --allow-missing-paths"); }
  const result: SetupResult = {
    ok: true,
    root,
    changed,
    created,
    files: { config: configPath, env: envPath, unit: unitPath },
    listen: { host: config.listen.host, port: config.listen.port },
    secret: { written: !options.dryRun && envAction === "create", printed: options.printSecret === true, ...(options.printSecret ? { value: password } : {}) },
    pending,
    warnings,
    next: unitPath
      ? [`systemctl daemon-reload`, `systemctl enable --now ${path.basename(unitPath)}`]
      : [`climier server run ${configPath}`],
  };
  if (options.dryRun) { result.actions = actions; }
  return result;
}
