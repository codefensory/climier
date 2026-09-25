import { timingSafeEqual } from "node:crypto";

function authError(code, message) {
  return Object.assign(new Error(`server auth: ${message}`), { code });
}

function bearerToken(authorization) {
  if (typeof authorization !== "string") {
    throw authError("AUTH_REQUIRED", "bearer token is required");
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) throw authError("AUTH_REQUIRED", "bearer token is required");
  return match[1];
}

function tokenMatches(candidate, configured) {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(configured, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function credentialForToken(token, credentials) {
  const matches = credentials.filter((credential) =>
    credential && typeof credential.token === "string" && tokenMatches(token, credential.token));
  if (matches.length !== 1) throw authError("AUTH_INVALID", "bearer token is invalid");
  return matches[0];
}

export async function withAuthorizedProject({
  authorization,
  projectId,
  credentials = [],
  catalog,
  openProject,
  provision = false,
} = {}) {
  const token = bearerToken(authorization);
  const credential = credentialForToken(token, credentials);
  const scopes = Array.isArray(credential.projectIds) ? credential.projectIds : [];
  if (!scopes.includes(projectId)) {
    throw authError("PROJECT_SCOPE_DENIED", "token is not authorized for the requested project");
  }
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog is unavailable");
  }
  if (typeof openProject !== "function") {
    throw authError("PROJECT_OPENER_REQUIRED", "project storage opener is required");
  }

  const resolveProject = provision ? catalog.provisionProject : catalog.resolveProject;
  if (typeof resolveProject !== "function") {
    throw authError("CATALOG_UNAVAILABLE", "trusted project catalog cannot provision projects");
  }
  const storagePath = await resolveProject.call(catalog, projectId);
  return openProject(storagePath, { projectId });
}
