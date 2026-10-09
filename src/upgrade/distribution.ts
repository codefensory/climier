import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const CLIMIER_DISTRIBUTION: string | undefined;

export type Distribution = "binary" | "npm" | "source-link" | "one-off";

type DetectionOptions = {
  modulePath?: string;
  definedDistribution?: string;
};

function isDistribution(value: string | undefined): value is Distribution {
  return value === "binary" || value === "npm" || value === "source-link" || value === "one-off";
}

function realModulePath(modulePath: string | undefined): string {
  return fsSync.realpathSync(modulePath ?? fileURLToPath(import.meta.url));
}

function sourceRoot(modulePath: string): string {
  return path.resolve(path.dirname(modulePath), "../..");
}

export function detectDistribution(options: DetectionOptions = {}): Distribution {
  const definedDistribution = options.definedDistribution ?? (typeof CLIMIER_DISTRIBUTION === "string" ? CLIMIER_DISTRIBUTION : undefined);
  if (isDistribution(definedDistribution)) {
    return definedDistribution;
  }

  const modulePath = realModulePath(options.modulePath);
  if (/(^|[/\\])node_modules([/\\]|$)/.test(modulePath)) {
    return "npm";
  }
  if (fsSync.existsSync(path.join(sourceRoot(modulePath), ".git"))) {
    return "source-link";
  }
  return "one-off";
}

export function distribution(): Distribution {
  return detectDistribution();
}
