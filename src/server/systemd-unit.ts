import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectDistribution, type Distribution } from "../upgrade/distribution.ts";

export type SystemdUnitOptions = {
  root: string;
  dataRoot: string;
  stateHome: string;
  serviceUser?: string;
  distribution?: Distribution;
  modulePath?: string;
  runtimePath?: string;
};

function requiredPath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`systemd unit: ${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function modulePath(options: SystemdUnitOptions): string {
  return fsSync.realpathSync(options.modulePath ?? fileURLToPath(import.meta.url));
}

function cliCommand(configPath: string, options: SystemdUnitOptions): string {
  const executable = requiredPath(options.runtimePath ?? process.execPath, "runtimePath");
  const distribution = options.distribution ?? (options.modulePath === undefined
    ? detectDistribution()
    : detectDistribution({ modulePath: options.modulePath }));
  if (distribution === "binary") {
    return [executable, "server", "run", configPath].join(" ");
  }
  const packageRoot = path.resolve(path.dirname(modulePath(options)), "../..");
  return [executable, path.join(packageRoot, "bin", "climier.ts"), "server", "run", configPath].join(" ");
}

/** Resolve the executable command used by generated units without relying on an npm shim. */
export function resolveServerExecStart(options: SystemdUnitOptions): string {
  const root = requiredPath(options.root, "root");
  return cliCommand(path.join(root, "server.json"), options);
}

/** Render the unit without installing, enabling, or starting it. */
export function renderSystemdUnit(options: SystemdUnitOptions): string {
  const root = requiredPath(options.root, "root");
  const dataRoot = requiredPath(options.dataRoot, "dataRoot");
  const stateHome = requiredPath(options.stateHome, "stateHome");
  const lines = [
    "[Unit]",
    "Description=Climier server",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${resolveServerExecStart({ ...options, root })}`,
    `EnvironmentFile=${path.join(root, "server.env")}`,
    "Restart=on-failure",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadWritePaths=${dataRoot} ${stateHome}`,
  ];
  if (options.serviceUser !== undefined) {
    if (typeof options.serviceUser !== "string" || !/^\S+$/u.test(options.serviceUser)) {
      throw new TypeError("systemd unit: serviceUser must be a non-empty name without whitespace");
    }
    lines.push(`User=${options.serviceUser}`, `Group=${options.serviceUser}`);
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}
