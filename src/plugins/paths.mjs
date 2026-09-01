// Global plugin layout under CLIMIER_HOME/plugins.
//
// ADR-005 §"Instalación e identidad": the installed directory name IS
// descriptor.id. descriptor.command is the CLI namespace (the first
// non-flag token); the dispatcher scans installed/*/package.json to
// discover it (no persistent registry).
//
// Layout:
//   <CLIMIER_HOME>/plugins/
//     .lock                  — global plugin lock (see plugin-lock.mjs)
//     installed/<id>/        — promoted plugin (one dir per descriptor.id)
//     .staging/<nonce>/      — transient npm install prefix
//
// "id" is the validated climier.id from the descriptor (regex in
// plugin-descriptor.mjs). "command" is descriptor.command (the CLI
// namespace; discovered by scanning installed/*/package.json).
// "nonce" is a per-install random hex string.

import path from "node:path";
import { climierHome } from "../storage/paths.mjs";
import { stateFile } from "../storage/state.mjs";
import { validatePluginId } from "./descriptor.mjs";

export function pluginsHome() {
  return path.join(climierHome(), "plugins");
}

export function pluginInstalledDir(id) {
  return path.join(pluginsHome(), "installed", id);
}

export function pluginStagingDir(nonce) {
  return path.join(pluginsHome(), ".staging", nonce);
}

export function globalPluginLockPath() {
  return path.join(pluginsHome(), ".lock");
}

// pluginRuntimeDataDir — resolve the private, plugin-owned runtime directory
// for a project. The project state directory is keyed by the project's stable
// id, while the plugin id is validated by the same descriptor contract before
// it can become a path component.
export function pluginRuntimeDataDir(projectDir, pluginId) {
  const validPluginId = validatePluginId(pluginId);
  return path.join(path.dirname(stateFile(projectDir)), "plugins", validPluginId);
}
