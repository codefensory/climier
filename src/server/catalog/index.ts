import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorProperties, isRecord } from "../types.ts";

type ProjectMetadata = {
  version?: unknown;
  project_id?: unknown;
  source_project_id?: unknown;
  name?: unknown;
};
type ListedMetadata = ProjectMetadata & { source_project_id: string; name: string | null };
type ListedProject = ListedMetadata & { projectDir: string };

const PROJECT_METADATA_FILE = ".climier.json";

function contractError(code: string, message: string) {
  return Object.assign(new Error(`server catalog: ${message}`), { code });
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validateProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0
      || Buffer.byteLength(projectId, "utf8") > 256 || hasControlCharacter(projectId)) {
    throw contractError("INVALID_PROJECT_ID", "project ID must be a non-empty bounded opaque identifier");
  }
}

function projectDirectoryName(projectId) {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

function throwProjectResolutionError(error: unknown, create: boolean): never {
  const properties = errorProperties(error);
  if (properties.code === "ENOENT" && !create) {
    throw contractError("UNKNOWN_PROJECT", "project is not provisioned");
  }
  throw error;
}

async function resolveRoot(dataRoot: string, create: boolean): Promise<string> {
  const root = path.resolve(dataRoot);
  if (create) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  try {
    return await fs.realpath(root);
  } catch (error) {
    throwProjectResolutionError(error, create);
  }
}

async function createProjectDirectory(expectedPath: string) {
  try {
    await fs.mkdir(expectedPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (errorProperties(error).code !== "EEXIST") {
      throw error;
    }
  }
}

async function inspectProjectDirectory(expectedPath: string, create: boolean): Promise<{ projectReal: string; info: Awaited<ReturnType<typeof fs.lstat>> }> {
  try {
    const [projectReal, info] = await Promise.all([
      fs.realpath(expectedPath),
      fs.lstat(expectedPath),
    ]);
    return { projectReal, info };
  } catch (error) {
    throwProjectResolutionError(error, create);
  }
}

async function ensureConfinedDirectory(dataRoot: string, storagePath: string, { create }: { create: boolean }) {
  const rootReal = await resolveRoot(dataRoot, create);
  const expectedPath = path.join(rootReal, path.basename(storagePath));
  if (storagePath !== expectedPath) {
    throw contractError("UNSAFE_PROJECT_STORAGE", "catalog path is outside the configured data root");
  }

  if (create) {
    await createProjectDirectory(expectedPath);
  }

  const { projectReal, info } = await inspectProjectDirectory(expectedPath, create);
  if (!info.isDirectory() || info.isSymbolicLink() || projectReal !== expectedPath) {
    throw contractError("UNSAFE_PROJECT_STORAGE", "project storage must be a real directory beneath data root");
  }
  return expectedPath;
}

function metadataFor(projectId: string, name?: string) {
  return {
    version: 1,
    project_id: projectDirectoryName(projectId),
    source_project_id: projectId,
    ...(name === undefined ? {} : { name }),
  };
}

async function createMetadataIfMissing(projectDir: string, projectId: string, name?: string) {
  const metadataFile = path.join(projectDir, PROJECT_METADATA_FILE);
  const raw = `${JSON.stringify(metadataFor(projectId, name), null, 2)}\n`;
  try {
    const handle = await fs.open(metadataFile, "wx", 0o600);
    try {
      await handle.writeFile(raw, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorProperties(error).code !== "EEXIST") {
      throw error;
    }
  }
}

async function readMetadataForListing(metadataFile: string): Promise<ProjectMetadata | null> {
  let info;
  try {
    info = await fs.lstat(metadataFile);
  } catch {
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return null;
  }

  try {
    const metadata: unknown = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    if (!isRecord(metadata)) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

function validListedMetadata(metadata: ProjectMetadata | null, directoryName: string): ListedMetadata | null {
  if (metadata?.version !== 1 || metadata.project_id !== directoryName || typeof metadata.source_project_id !== "string") {
    return null;
  }
  try {
    validateProjectId(metadata.source_project_id);
  } catch {
    return null;
  }
  if (projectDirectoryName(metadata.source_project_id) !== directoryName) {
    return null;
  }
  if (metadata.name !== undefined && metadata.name !== null && typeof metadata.name !== "string") {
    return null;
  }
  return {
    ...metadata,
    source_project_id: metadata.source_project_id,
    name: metadata.name ?? null,
  };
}

export function createProjectCatalog({ dataRoot }: { dataRoot?: string } = {}) {
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    throw contractError("INVALID_DATA_ROOT", "dataRoot must be a non-empty path");
  }
  const rootPath = path.resolve(dataRoot);
  const storagePathFor = (projectId: string) => path.join(rootPath, projectDirectoryName(projectId));

  async function resolveProject(projectId: string) {
    validateProjectId(projectId);
    return ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: false });
  }

  async function provisionProject(projectId: string, { name }: { name?: string } = {}) {
    validateProjectId(projectId);
    if (name !== undefined && typeof name !== "string") {
      throw contractError("INVALID_PROJECT_NAME", "project name must be a string");
    }
    const projectDir = await ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: true });
    await createMetadataIfMissing(projectDir, projectId, name);
    return projectDir;
  }

  async function listProjects(): Promise<ListedProject[]> {
    let rootReal;
    try {
      rootReal = await fs.realpath(rootPath);
    } catch (error) {
      if (errorProperties(error).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let entries;
    try {
      entries = await fs.readdir(rootReal);
    } catch (error) {
      if (errorProperties(error).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const projects: ListedProject[] = [];
    for (const directoryName of entries) {
      const projectDir = path.join(rootReal, directoryName);
      let projectReal;
      let info;
      try {
        [projectReal, info] = await Promise.all([
          fs.realpath(projectDir),
          fs.lstat(projectDir),
        ]);
      } catch {
        continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink() || projectReal !== projectDir) {
        continue;
      }
      const metadata = validListedMetadata(
        await readMetadataForListing(path.join(projectDir, PROJECT_METADATA_FILE)),
        directoryName,
      );
      if (metadata) {
        projects.push({ ...metadata, projectDir });
      }
    }

    return projects.sort((left, right) => left.source_project_id.localeCompare(right.source_project_id));
  }

  return Object.freeze({ resolveProject, provisionProject, listProjects });
}
