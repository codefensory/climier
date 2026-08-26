// T-plugin-install — global plugin layout under CLIMIER_HOME/plugins/.
//
// Layout:
//   <CLIMIER_HOME>/plugins/
//     .lock                  — global plugin lock (see plugin-lock.mjs)
//     installed/<id>/        — promoted plugin (one dir per climier.id)
//     .staging/<nonce>/      — transient npm install prefix
//
// "id" is the validated climier.id from the descriptor (regex in
// plugin-descriptor.mjs). "nonce" is a per-install random hex string.

import path from "node:path";
import { climierHome } from "./paths.mjs";

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
