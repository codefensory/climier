import path from "node:path";

export type SystemdUnitOptions = {
  root: string;
  dataRoot: string;
  stateHome: string;
  serviceUser?: string;
};

function requiredPath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`systemd unit: ${name} must be an absolute path`);
  }
  return path.resolve(value);
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
    `ExecStart=${path.join(root, "climier-server")} ${path.join(root, "server.json")}`,
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
