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
import { readState, stateFile } from "../../storage/state.mjs";

export const knownFlags = ["port", "open"];

const DEFAULT_PORT = 7373;

export const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "ui",
);
const DIST_INDEX = path.join(UI_DIR, "dist", "index.html");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function assertUiSubproject(uiDir = UI_DIR) {
  const serverEntry = path.join(uiDir, "server", "server.mjs");
  const dependencies = path.join(uiDir, "node_modules", "express");
  const missing = [];
  if (!fsSync.existsSync(serverEntry)) {missing.push("ui/server/server.mjs");}
  if (!fsSync.existsSync(dependencies)) {missing.push("ui/node_modules/express");}
  if (missing.length > 0) {
    const error = new Error(
      `ui: experimental UI is unavailable (${missing.join(", ")}). Run \`npm install\` in ${uiDir} to enable it, or use the CLI without \`ui\`.`,
    );
    error.code = "UI_SUBPROJECT_MISSING";
    error.details = { ui_dir: uiDir, missing, action: `cd ${uiDir} && npm install` };
    throw error;
  }
}

function ensureDeps() {
  assertUiSubproject(UI_DIR);
}

function ensureBuild() {
  if (fsSync.existsSync(DIST_INDEX)) {return;}
  // Build output goes to stderr so stdout stays a single JSON value.
  const r = spawnSync(npmCommand(), ["run", "build"], { cwd: UI_DIR, stdio: ["ignore", 2, 2] });
  if (r.error || r.status !== 0) {
    throw new Error(`ui: failed to build the UI in ${UI_DIR} (run \`cd ${UI_DIR} && npm run build\` for details)`);
  }
}

function browserCommand(url) {
  if (process.platform === "darwin") {return ["open", [url]];}
  if (process.platform === "win32") {return ["cmd", ["/c", "start", "", url]];}
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [command, args] = browserCommand(url);
  try {
    const { spawn } = awaitImportChildProcess();
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
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

  // Read through the CLI storage boundary before touching optional UI code.
  // Corrupt or incompatible state must retain its binary storage error.
  await readState(projectDir);
  ensureDeps();
  ensureBuild();

  const server = await import(pathToFileURL(path.join(UI_DIR, "server", "server.mjs")).href);
  let started;
  try {
    started = await server.start({ projectDir, port: finalPort });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      throw new Error(`ui: port ${finalPort} is already in use; pick another with --port <n>`, { cause: err });
    }
    throw err;
  }

  if (open) {void openBrowser(started.url);}

  return {
    ui: {
      url: started.url,
      project: projectDir,
      state_file: stateFile(projectDir),
      read_only: true,
    },
  };
}
