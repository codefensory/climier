import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_METADATA_FILE = ".climier.json";

function contractError(code, message) {
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

function throwProjectResolutionError(error, create) {
  if (error.code === "ENOENT" && !create) {
    throw contractError("UNKNOWN_PROJECT", "project is not provisioned");
  }
  throw error;
}

async function resolveRoot(dataRoot, create) {
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

async function createProjectDirectory(expectedPath) {
  try {
    await fs.mkdir(expectedPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function inspectProjectDirectory(expectedPath, create) {
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

async function ensureConfinedDirectory(dataRoot, storagePath, { create }) {
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

function metadataFor(projectId, name) {
  return {
    version: 1,
    project_id: projectDirectoryName(projectId),
    source_project_id: projectId,
    ...(name === undefined ? {} : { name }),
  };
}

async function createMetadataIfMissing(projectDir, projectId, name) {
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
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function readMetadataForListing(metadataFile) {
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
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

function validListedMetadata(metadata, directoryName) {
  if (metadata?.version !== 1 || metadata.project_id !== directoryName) {
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
    name: metadata.name ?? null,
  };
}

export function createProjectCatalog({ dataRoot } = {}) {
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    throw contractError("INVALID_DATA_ROOT", "dataRoot must be a non-empty path");
  }
  const rootPath = path.resolve(dataRoot);
  const storagePathFor = (projectId) => path.join(rootPath, projectDirectoryName(projectId));

  async function resolveProject(projectId) {
    validateProjectId(projectId);
    return ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: false });
  }

  async function provisionProject(projectId, { name } = {}) {
    validateProjectId(projectId);
    if (name !== undefined && typeof name !== "string") {
      throw contractError("INVALID_PROJECT_NAME", "project name must be a string");
    }
    const projectDir = await ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: true });
    await createMetadataIfMissing(projectDir, projectId, name);
    return projectDir;
  }

  async function listProjects() {
    let rootReal;
    try {
      rootReal = await fs.realpath(rootPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let entries;
    try {
      entries = await fs.readdir(rootReal);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const projects = [];
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
