import type { CliFlags } from "./contracts.ts";

type CliWarning = {
  kind: "insecure-remote-http";
  severity: "warning";
  message: string;
};

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function insecureRemoteHttpWarning(command: string, value: string): CliWarning | undefined {
  const url = new URL(value);
  if (url.protocol !== "http:" || isLoopback(url.hostname)) {
    return undefined;
  }
  return {
    kind: "insecure-remote-http",
    severity: "warning",
    message: `${command}: ${url.origin} is not HTTPS; the login password and bearer travel without transport encryption.`,
  };
}

export function warningField(command: string, value: string | undefined, flags: CliFlags = {}): { warnings?: CliWarning[] } {
  if (flags["no-warnings"] === true || flags["no-warnings"] === "true" || typeof value !== "string") {
    return {};
  }
  const warning = insecureRemoteHttpWarning(command, value);
  return warning ? { warnings: [warning] } : {};
}
