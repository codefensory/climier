function authError(code, message) {
  return Object.assign(new Error(`server auth: ${message}`), { code });
}

function bearerToken(authorization) {
  if (typeof authorization !== "string") {
    throw authError("AUTH_REQUIRED", "bearer token is required");
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    throw authError("AUTH_REQUIRED", "bearer token is required");
  }
  return match[1];
}

function assertCatalogAvailable(catalog) {
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog is unavailable");
  }
}

function projectResolver(catalog, provision) {
  const resolveProject = provision ? catalog.provisionProject : catalog.resolveProject;
  if (typeof resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog cannot provision projects");
  }
  return resolveProject;
}

async function assertBearer(authStore, authorization) {
  if (!authStore || typeof authStore.verifyBearer !== "function") {
    throw authError("AUTH_STORE_UNAVAILABLE", "server auth store is unavailable");
  }
  if (!await authStore.verifyBearer(bearerToken(authorization))) {
    throw authError("AUTH_INVALID", "bearer token is invalid");
  }
}

export async function withAuthorizedProject({
  authorization,
  projectId,
  authStore,
  catalog,
  openProject,
  provision = false,
} = {}) {
  await assertBearer(authStore, authorization);
  assertCatalogAvailable(catalog);
  if (typeof openProject !== "function") {
    throw authError("PROJECT_OPENER_REQUIRED", "project storage opener is required");
  }

  const resolveProject = projectResolver(catalog, provision);
  const storagePath = await resolveProject.call(catalog, projectId);
  return openProject(storagePath, { projectId });
}
