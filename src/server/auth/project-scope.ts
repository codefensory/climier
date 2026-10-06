type Catalog = {
  resolveProject?: (projectId: string) => Promise<string>;
  provisionProject?: (projectId: string) => Promise<string>;
};

type AuthStore = { verifyBearer: (token: string) => Promise<boolean> };
type AuthorizedProject = { projectDir: string; [key: string]: unknown };
type OpenProject = (storagePath: string, metadata?: { projectId?: string }) => Promise<AuthorizedProject>;
type AuthorizedProjectOptions = {
  authorization?: unknown;
  projectId?: string;
  authStore?: AuthStore;
  catalog?: Catalog;
  openProject?: OpenProject;
  provision?: boolean;
};

function authError(code: string, message: string) {
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

function assertCatalogAvailable(catalog: Catalog | undefined): asserts catalog is Catalog & { resolveProject: NonNullable<Catalog["resolveProject"]> } {
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog is unavailable");
  }
}

function projectResolver(catalog: Catalog, provision: boolean) {
  const resolveProject = provision ? catalog.provisionProject : catalog.resolveProject;
  if (typeof resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog cannot provision projects");
  }
  return resolveProject;
}

async function assertBearer(authStore: AuthStore | undefined, authorization: unknown) {
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
}: AuthorizedProjectOptions = {}) {
  await assertBearer(authStore, authorization);
  assertCatalogAvailable(catalog);
  if (typeof openProject !== "function") {
    throw authError("PROJECT_OPENER_REQUIRED", "project storage opener is required");
  }

  const resolveProject = projectResolver(catalog, provision);
  const storagePath = await resolveProject.call(catalog, projectId as string);
  return openProject(storagePath, { projectId });
}
