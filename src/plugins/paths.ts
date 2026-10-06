
import path from "node:path";
import { climierHome } from "../storage/paths.ts";
import { stateFile } from "../storage/state.ts";
import { validatePluginId } from "./descriptor.ts";

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

export function pluginRuntimeDataDir(projectDir, pluginId) {
  const validPluginId = validatePluginId(pluginId);
  return path.join(path.dirname(stateFile(projectDir)), "plugins", validPluginId);
}
