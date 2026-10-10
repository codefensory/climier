import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectDistribution, type Distribution } from "../upgrade/distribution.ts";

export type PackagedUi =
  | { kind: "fs"; root: string }
  | { kind: "embedded"; files: Map<string, Uint8Array> };

type ResolverOptions = {
  distribution?: Distribution;
  moduleUrl?: string;
};

async function readDirectory(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readEmbeddedFiles(directory: string, prefix = "", files = new Map<string, Uint8Array>()) {
  const entries = await readDirectory(directory);
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await readEmbeddedFiles(absolute, relative, files);
    } else if (entry.isFile()) {
      files.set(relative, await fs.readFile(absolute));
    }
  }
  return files;
}

export function createPackagedUiResolver({ distribution, moduleUrl = import.meta.url }: ResolverOptions = {}) {
  let resolved: Promise<PackagedUi> | undefined;
  return function resolvePackagedUi(): Promise<PackagedUi> {
    if (!resolved) {
      const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
      const selectedDistribution = distribution ?? detectDistribution();
      resolved = selectedDistribution === "binary"
        ? readEmbeddedFiles(path.join(moduleDirectory, "ui", "dist")).then(async (files) => {
          if (files.size > 0) {
            return { kind: "embedded" as const, files };
          }
          const flattenedAssets = await readEmbeddedFiles(path.join(moduleDirectory, "dist"));
          return { kind: "embedded" as const, files: flattenedAssets.size > 0 ? flattenedAssets : files };
        })
        : Promise.resolve({ kind: "fs", root: path.resolve(moduleDirectory, "..", "..", "ui", "dist") });
    }
    return resolved;
  };
}

export const resolvePackagedUi = createPackagedUiResolver();
