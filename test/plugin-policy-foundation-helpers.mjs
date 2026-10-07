import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTempProject } from "./helpers.ts";

export async function freshHome(prefix = "climier-policy-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const projectDir = await createTempProject();
  const prevHome = process.env.CLIMIER_HOME;
  const prevAgent = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_HOME = home;
  if (!("CLIMIER_AGENT" in process.env)) {
    process.env.CLIMIER_AGENT = "test-agent";
  }
  return {
    home,
    projectDir,
    restore() {
      if (prevHome === undefined) {
        delete process.env.CLIMIER_HOME;
      } else {
        process.env.CLIMIER_HOME = prevHome;
      }
      if (prevAgent === undefined) {
        delete process.env.CLIMIER_AGENT;
      } else {
        process.env.CLIMIER_AGENT = prevAgent;
      }
    },
    async cleanup() {
      if (prevHome === undefined) {
        delete process.env.CLIMIER_HOME;
      } else {
        process.env.CLIMIER_HOME = prevHome;
      }
      if (prevAgent === undefined) {
        delete process.env.CLIMIER_AGENT;
      } else {
        process.env.CLIMIER_AGENT = prevAgent;
      }
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    },
  };
}

export async function withEnv(body, prefix = "climier-policy-test") {
  const env = await freshHome(prefix);
  try {
    return await body(env);
  } finally {
    await env.cleanup();
  }
}

export async function writePlugin(home, opts) {
  const id = opts.id ?? opts.command;
  const command = opts.command ?? id;
  const installedDir = path.join(home, "plugins", "installed", id);
  await fs.mkdir(installedDir, { recursive: true });
  await fs.writeFile(
    path.join(installedDir, "package.json"),
    JSON.stringify(
      {
        name: opts.npmName ?? id,
        version: "1.0.0",
        type: "module",
        climier: { id, command, entry: "./climier.mjs", api: 1 },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.writeFile(path.join(installedDir, "climier.mjs"), opts.entryCode, "utf8");
  return installedDir;
}

export function policyFixture(opts = {}) {
  const appliesMode = opts.appliesMode ?? "true";
  const authorizeMode = opts.authorizeMode ?? "allow";
  const reason = JSON.stringify(opts.reason ?? "deny reason");
  const appliesExtra = opts.appliesExtra ?? "";
  const authorizeExtra = opts.authorizeExtra ?? "";
  return (
    "function _appliesImpl(cfg) {\n" +
    "  " + appliesExtra + "\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"true\") return true;\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"false\") return false;\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"throw\") throw new Error(\"applies boom\");\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"nonbool\") return \"truthy\";\n" +
    "  return " + JSON.stringify(appliesMode) + ";\n" +
    "}\n" +
    "function _authorizeImpl(input) {\n" +
    "  " + authorizeExtra + "\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"allow\") return { decision: \"allow\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"deny\") return { decision: \"deny\", reason: " + reason + " };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"abstain\") return { decision: \"abstain\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"throw\") throw new Error(\"authorize boom\");\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"invalid\") return { decision: \"maybe\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"null\") return null;\n" +
    "  return " + JSON.stringify(authorizeMode) + ";\n" +
    "}\n" +
    "export default {\n" +
    "  commands: {},\n" +
    "  policy: {\n" +
    "    applies: _appliesImpl,\n" +
    "    authorize: _authorizeImpl,\n" +
    "  },\n" +
    "};\n"
  );
}

export function commandOnlyFixture() {
  return (
    "export default {\n" +
    "  commands: { ping: () => ({ ok: true, command: 'ping' }) },\n" +
    "};\n"
  );
}

export function policyFailureForField(field) {
  return (err) =>
    err.code === "PLUGIN_LOAD_FAILED" && err.details && err.details.field === field;
}
