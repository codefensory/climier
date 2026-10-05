import {
  projectUiActivity,
  projectUiNode,
  projectUiSnapshot,
} from "../../read-model/ui.mjs";

const UI_ROUTES = [
  ["snapshot", /^ui\/snapshot$/, []],
  ["node", /^ui\/nodes\/([^/]+)$/, []],
  ["activity", /^ui\/activity$/, ["limit", "offset", "action", "agent", "node", "q", "initiative"]],
];

function uiError(code, message, details, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function invalidQuery(message, details) {
  return uiError("INVALID_QUERY", `server http: ${message}`, details, 400);
}

function matchUiRoute(route, decode = decodeURIComponent) {
  for (const [kind, pattern, allowedQuery] of UI_ROUTES) {
    const match = pattern.exec(route);
    if (!match) {
      continue;
    }
    if (match[1] === undefined) {
      return { kind, allowedQuery };
    }
    let id;
    try {
      id = decode(match[1]);
    } catch {
      throw uiError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
    }
    return { kind, id, allowedQuery };
  }
  return null;
}

function parseNonNegativeInteger(value, parameter) {
  if (!/^\d+$/.test(value)) {
    throw invalidQuery(`query parameter '${parameter}' must be a non-negative integer`, { parameter, value });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidQuery(`query parameter '${parameter}' must be a non-negative integer`, { parameter, value });
  }
  return parsed;
}

function parseUiQuery(url, route) {
  const searchParams = typeof url === "string"
    ? new URL(url, "http://localhost").searchParams
    : url?.searchParams;
  if (!searchParams || !route) {
    return {};
  }
  const parsed = {};
  for (const [key, value] of searchParams) {
    if (!route.allowedQuery.includes(key)) {
      throw invalidQuery(`query parameter '${key}' is not allowed for ${route.kind}`, { parameter: key });
    }
    if (Object.hasOwn(parsed, key)) {
      throw invalidQuery(`query parameter '${key}' must not be repeated`, { parameter: key });
    }
    parsed[key] = value;
  }
  for (const key of ["limit", "offset"]) {
    if (Object.hasOwn(parsed, key)) {
      parsed[key] = parseNonNegativeInteger(parsed[key], key);
    }
  }
  return parsed;
}

function requireDependencies({ getProject, authorize, readSnapshot }) {
  for (const [value, message] of [
    [getProject, "getProject must be a function"],
    [authorize, "authorize must be a function"],
    [readSnapshot, "readSnapshot must be a function"],
  ]) {
    if (typeof value !== "function") {
      throw new TypeError(`server http ui: ${message}`);
    }
  }
}

function routeProject(project, projectId) {
  if (project && typeof project === "object") {
    return { ...project, id: project.id ?? project.project_id ?? projectId };
  }
  return { id: projectId, name: projectId, value: project };
}

export function createUiApi({ getProject, authorize, readSnapshot, clock = Date.now } = {}) {
  requireDependencies({ getProject, authorize, readSnapshot });
  if (typeof clock !== "function") {
    throw new TypeError("server http ui: clock must be a function");
  }

  async function read({ request, projectId, route, query = {}, now } = {}) {
    await authorize(request, { projectId });
    const project = await getProject(projectId, { request });
    if (!project) {
      throw uiError("UNKNOWN_PROJECT", "server http: project is not provisioned", { projectId }, 404);
    }
    const resolvedProject = routeProject(project, projectId);
    const snapshot = await readSnapshot(resolvedProject, { request, projectId });
    if (!snapshot) {
      throw uiError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
    }
    const view = route?.kind === "snapshot"
      ? projectUiSnapshot({ snapshot, project: resolvedProject, now: now ?? clock() })
      : route?.kind === "node"
        ? projectUiNode({ snapshot, id: route.id })
        : route?.kind === "activity"
          ? projectUiActivity({ snapshot, filters: query, limit: query.limit, offset: query.offset })
          : null;
    if (route?.kind === "node" && !view) {
      throw uiError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
    }
    if (!view) {
      throw uiError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
    }
    return view;
  }

  return Object.freeze({
    matchRoute: (route) => matchUiRoute(route),
    parseQuery: (url, route) => parseUiQuery(url, route),
    read,
    projectUiResult: read,
  });
}

export { matchUiRoute, parseUiQuery };
