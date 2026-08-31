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
