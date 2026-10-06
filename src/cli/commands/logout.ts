import { createCredentialStore, normalizeOrigin } from "../../storage/credential-profile.ts";
import type { CliFlags, CommandContext } from "./contracts.ts";

export const knownFlags = ["server"];

function usage(message, details) {
  const error = new Error(`logout: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  if (details !== undefined) {error.details = details;}
  return error;
}

function checkedOrigin(value) {
  try {return normalizeOrigin(value);}
  catch (cause) {throw usage(String(cause).replace(/^credential store: /, ""), { field: "server" });}
}

function serverOrigin(flags: CliFlags, projectConfig: Record<string, unknown>) {
  if (typeof flags.server === "string" && flags.server) {return checkedOrigin(flags.server);}
  if (flags.server !== undefined) {throw usage("--server requires an origin", { flag: "server" });}
  const backend = projectConfig.backend;
  if (backend && typeof backend === "object" && !Array.isArray(backend)) {
    const remote = backend as { type?: unknown; url?: unknown };
    if (remote.type === "remote" && typeof remote.url === "string") {
      return checkedOrigin(remote.url);
    }
  }
  throw usage("--server is required when the checkout is not linked remotely", { flag: "server" });
}

export default async function logout({ positional = [], flags = {}, projectConfig = {}, credentialStore = createCredentialStore() }: CommandContext & { credentialStore?: Readonly<{ delete(origin: string): Promise<boolean> }> }) {
  if (positional.length) {throw usage("does not accept positional arguments", { positional_count: positional.length });}
  const origin = serverOrigin(flags, projectConfig);
  const removed = await credentialStore.delete(origin);
  return { session: { origin, removed } };
}
