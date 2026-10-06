import { createCredentialStore, normalizeOrigin } from "../../storage/credential-profile.ts";

export const knownFlags = ["server"];

function usage(message, details) {
  const error = new Error(`logout: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  if (details !== undefined) {error.details = details;}
  return error;
}

function checkedOrigin(value) {
  try {return normalizeOrigin(value);}
  catch (cause) {throw usage(cause.message.replace(/^credential store: /, ""), { field: "server" });}
}

function serverOrigin(flags, projectConfig) {
  if (typeof flags.server === "string" && flags.server) {return checkedOrigin(flags.server);}
  if (flags.server !== undefined) {throw usage("--server requires an origin", { flag: "server" });}
  if (projectConfig?.backend?.type === "remote" && typeof projectConfig.backend.url === "string") {
    return checkedOrigin(projectConfig.backend.url);
  }
  throw usage("--server is required when the checkout is not linked remotely", { flag: "server" });
}

export default async function logout({ positional = [], flags = {}, projectConfig = {}, credentialStore = createCredentialStore() } = {}) {
  if (positional.length) {throw usage("does not accept positional arguments", { positional_count: positional.length });}
  const origin = serverOrigin(flags, projectConfig);
  const removed = await credentialStore.delete(origin);
  return { session: { origin, removed } };
}
