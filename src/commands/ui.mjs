// ui: start the local climier web UI (read-only projection of a project's live state).
//
// Read-only for now: no mutations. The UI's browser never touches the state
// file; the local Express server (ui/server/server.mjs) reads it using the
// CLI's own derivation functions.
//
// Flow: ensure ui deps are installed -> ensure ui/dist is built (build on
// demand) -> import the server -> open the browser -> stay alive serving.
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateFile } from "../storage/state.mjs";

export const knownFlags = ["port", "open"];

const DEFAULT_PORT = 7373;

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui");
const NODE_MODULES = path.join(UI_DIR, "node_modules");
const DIST_INDEX = path.join(UI_DIR, "dist", "index.html");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureDeps() {
  if (!fsSync.existsSync(path.join(NODE_MODULES, "express"))) {
    throw new Error(
      `ui: dependencies missing in ${UI_DIR}. Run: (cd ${UI_DIR} && npm install)`,
    );
  }
}

function ensureBuild() {
  if (fsSync.existsSync(DIST_INDEX)) return;
  // Build output goes to stderr so stdout stays a single JSON value.
  const r = spawnSync(npmCommand(), ["run", "build"], { cwd: UI_DIR, stdio: ["ignore", 2, 2] });
  if (r.error || r.status !== 0) {
    throw new Error(`ui: failed to build the UI in ${UI_DIR} (run \`cd ${UI_DIR} && npm run build\` for details)`);
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const { spawn } = awaitImportChildProcess();
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Opening a browser is a nicety; failure must not kill the server.
  }
}

function awaitImportChildProcess() {
  return import("node:child_process");
}

export default async function uiCommand(ctx) {
  const projectDir = ctx.projectDir;
  const open = ctx.flags.open !== "false" && ctx.flags.open !== false;
  const port = parseInt(ctx.flags.port, 10);
  const finalPort = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;

  ensureDeps();
  ensureBuild();

  const server = await import(pathToFileURL(path.join(UI_DIR, "server", "server.mjs")).href);
  let started;
  try {
    started = await server.start({ projectDir, port: finalPort });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      throw new Error(`ui: port ${finalPort} is already in use; pick another with --port <n>`);
    }
    throw err;
  }

  if (open) openBrowser(started.url);

  return {
    ui: {
      url: started.url,
      project: projectDir,
      state_file: stateFile(projectDir),
      read_only: true,
    },
  };
}
