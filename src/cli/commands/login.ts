import fs from "node:fs";
import tty from "node:tty";
import { StringDecoder } from "node:string_decoder";

import { createCredentialStore, normalizeOrigin } from "../../storage/credential-profile.ts";
import { loginRemote } from "../../application/backend-remote-transport.ts";

export const knownFlags = ["server"];

function loginError(code, message, details) {
  const error = new Error(`login: ${message}`);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function checkedOrigin(value) {
  try {return normalizeOrigin(value);}
  catch (cause) {throw loginError("CLI_USAGE_ERROR", cause.message.replace(/^credential store: /, ""), { field: "server" });}
}

function serverOrigin(flags, projectConfig) {
  if (typeof flags.server === "string" && flags.server) {return checkedOrigin(flags.server);}
  if (flags.server !== undefined) {throw loginError("CLI_USAGE_ERROR", "--server requires an origin", { flag: "server" });}
  if (projectConfig?.backend?.type === "remote" && typeof projectConfig.backend.url === "string") {
    return checkedOrigin(projectConfig.backend.url);
  }
  throw loginError("CLI_USAGE_ERROR", "--server is required when the checkout is not linked remotely", { flag: "server" });
}

export async function readPasswordFromTty() {
  let fd;
  try { fd = fs.openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r+"); }
  catch (cause) {
    const error = loginError("INTERACTIVE_LOGIN_REQUIRED", "an interactive TTY is required");
    error.cause = cause;
    throw error;
  }
  const input = new tty.ReadStream(fd);
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    input.destroy();
    throw loginError("INTERACTIVE_LOGIN_REQUIRED", "an interactive TTY is required");
  }
  input.setRawMode(true);
  fs.writeSync(fd, "Password: ");
  input.resume();
  try {
    return await new Promise((resolve, reject) => {
      let password = "";
      const decoder = new StringDecoder("utf8");
      input.on("data", (chunk) => {
        for (const byte of chunk) {
          if (byte === 3) {reject(loginError("INTERACTIVE_LOGIN_REQUIRED", "login was cancelled")); return;}
          if (byte === 10 || byte === 13) {resolve(password + decoder.end()); return;}
          if (byte === 8 || byte === 127) {password = password.slice(0, -1); continue;}
          password += decoder.write(Buffer.from([byte]));
        }
      });
      input.once("error", reject);
    });
  } finally {
    input.setRawMode(false);
    fs.writeSync(fd, "\n");
    input.destroy();
  }
}

export default async function login({ positional = [], flags = {}, projectConfig = {}, readPassword = readPasswordFromTty, requestLogin = loginRemote, credentialStore = createCredentialStore() } = {}) {
  if (positional.length) {throw loginError("CLI_USAGE_ERROR", "does not accept positional arguments", { positional_count: positional.length });}
  const origin = serverOrigin(flags, projectConfig);
  const password = await readPassword();
  const session = await requestLogin({ origin, password });
  if (!session || typeof session.token !== "string" || !session.token) {
    throw loginError("REMOTE_INVALID_RESPONSE", "server response did not contain a bearer token");
  }
  await credentialStore.set(origin, session.token);
  return { session: { origin, ...(Number.isInteger(session.expires_in_days) ? { expires_in_days: session.expires_in_days } : {}) } };
}
