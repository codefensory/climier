import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const AUTH_FILE = "remote-auth.json";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function authPath(stateHome) {
  return path.join(stateHome, AUTH_FILE);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function passwordVerifier(password, salt = randomHex(16)) {
  const key = await scrypt(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    salt,
    key: Buffer.from(key).toString("hex"),
  };
}

async function verifyPassword(password, verifier) {
  if (!verifier || verifier.algorithm !== "scrypt" || typeof verifier.salt !== "string" || typeof verifier.key !== "string") {
    return false;
  }
  const candidate = await passwordVerifier(password, verifier.salt);
  return timingSafeEqualHex(candidate.key, verifier.key);
}

async function fsyncPath(targetPath) {
  const handle = await fs.open(targetPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAuthFileDurably(file, state, testHooks) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomHex(4)}.tmp`);
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncPath(dir);
  await testHooks?.beforeRename?.(tmp, file);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
  await fsyncPath(dir);
}

async function readAuthFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.password_verifier || !Array.isArray(parsed.sessions)) {
      throw codedError("AUTH_STORE_CORRUPT", `server auth: ${file} has invalid shape`, { file });
    }
    return parsed;
  } catch (error) {
    if (error.code === "AUTH_STORE_CORRUPT") {
      throw error;
    }
    throw codedError("AUTH_STORE_CORRUPT", `server auth: ${file} is corrupt`, { file });
  }
}

class ServerAuthStore {
  constructor({ file, state, now, testHooks }) {
    this.file = file;
    this.state = state;
    this.now = now;
    this.testHooks = testHooks;
    this.queue = Promise.resolve();
  }

  async persist(nextState) {
    await writeAuthFileDurably(this.file, nextState, this.testHooks);
    this.state = nextState;
  }

  serialize(update) {
    const next = this.queue.then(update, update);
    this.queue = next.catch(() => {});
    return next;
  }

  async login(password) {
    if (!await verifyPassword(password, this.state.password_verifier)) {
      throw codedError("AUTH_INVALID_PASSWORD", "server auth: invalid password");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    await this.serialize(async () => {
      const nowMs = this.now().getTime();
      const sessions = this.state.sessions.filter((session) => Date.parse(session.expires_at) > nowMs);
      sessions.push({
        token_hash: tokenHash(token),
        expires_at: new Date(nowMs + SESSION_TTL_MS).toISOString(),
      });
      await this.persist({ ...this.state, sessions });
    });
    return token;
  }

  async verifyBearer(token) {
    const hash = tokenHash(token);
    const nowMs = this.now().getTime();
    return this.state.sessions.some((session) => Date.parse(session.expires_at) > nowMs && timingSafeEqualHex(session.token_hash, hash));
  }
}

export async function createServerAuthStore({ stateHome, password, now = () => new Date(), testHooks } = {}) {
  if (typeof stateHome !== "string" || !stateHome.trim()) {
    throw new TypeError("server auth: stateHome is required");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw codedError("SERVER_PASSWORD_REQUIRED", "server auth: CLIMIER_SERVER_PASSWORD is required");
  }
  const file = authPath(stateHome);
  const existing = await readAuthFile(file);
  if (!existing) {
    const state = { version: 1, password_verifier: await passwordVerifier(password), sessions: [] };
    await writeAuthFileDurably(file, state, testHooks);
    return new ServerAuthStore({ file, state, now, testHooks });
  }
  if (await verifyPassword(password, existing.password_verifier)) {
    return new ServerAuthStore({ file, state: existing, now, testHooks });
  }
  const rotated = { version: 1, password_verifier: await passwordVerifier(password), sessions: [] };
  await writeAuthFileDurably(file, rotated, testHooks);
  return new ServerAuthStore({ file, state: rotated, now, testHooks });
}

export { AUTH_FILE, SESSION_TTL_MS };
