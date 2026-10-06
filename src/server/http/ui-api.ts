import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";

import {
  projectUiActivity,
  projectUiNode,
  projectUiSnapshot,
} from "../../read-model/ui.ts";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const BROTLI_QUALITY = 5;

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

function parseAcceptEncoding(value) {
  const result = new Map();
  if (typeof value !== "string") return result;
  for (const item of value.split(",")) {
    const [rawName, ...parameters] = item.trim().toLowerCase().split(";");
    const name = rawName.trim();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, rawValue] = parameter.trim().split("=", 2);
      if (key === "q") {
        const parsed = Number(rawValue);
        quality = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
      }
    }
    result.set(name, quality);
  }
  return result;
}

function encodingQuality(encodings, name) {
  return encodings.get(name) ?? encodings.get("*") ?? 0;
}

function selectContentEncoding(value) {
  const encodings = parseAcceptEncoding(value);
  const candidates = [
    ["br", encodingQuality(encodings, "br")],
    ["gzip", encodingQuality(encodings, "gzip")],
  ];
  candidates.sort((left, right) => right[1] - left[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : null;
}

function headerValue(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value.join(",") : value;
}

function matchesEtag(value, etag) {
  if (typeof value !== "string") return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function compressBody(body, encoding) {
  // Node's brotli default quality (11) spends seconds on multi-megabyte snapshots, and
  // the revision cache re-pays it after every mutation. Quality 5 keeps the response
  // interactive for roughly 10% larger bodies.
  if (encoding === "br") return compressBrotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } });
  if (encoding === "gzip") return compressGzip(body);
  return body;
}

async function cachedCompressedBody(cache, encoding) {
  const cached = cache.compressed.get(encoding);
  if (cached) return cached instanceof Promise ? cached : cached;
  const pending = compressBody(cache.body, encoding);
  cache.compressed.set(encoding, pending);
  try {
    const body = await pending;
    cache.compressed.set(encoding, body);
    return body;
  } catch (error) {
    if (cache.compressed.get(encoding) === pending) cache.compressed.delete(encoding);
    throw error;
  }
}

export function createUiApi({ getProject, authorize, readSnapshot, clock = Date.now } = {}) {
  requireDependencies({ getProject, authorize, readSnapshot });
  if (typeof clock !== "function") {
    throw new TypeError("server http ui: clock must be a function");
  }

  let snapshotCache;

  async function load({ request, projectId, now } = {}) {
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
    return { resolvedProject, snapshot, now: now ?? clock() };
  }

  function projectResult({ snapshot, resolvedProject, route, query, now }) {
    const view = route?.kind === "snapshot"
      ? projectUiSnapshot({ snapshot, project: resolvedProject, now })
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

  async function read({ request, projectId, route, query = {}, now } = {}) {
    const loaded = await load({ request, projectId, now });
    return projectResult({ ...loaded, route, query });
  }

  async function readSnapshotResponse({ request, projectId, now } = {}) {
    const loaded = await load({ request, projectId, now });
    const result = projectResult({ ...loaded, route: { kind: "snapshot" }, query: {} });
    const revision = result.project.revision;
    const etag = `"${revision}"`;
    const baseHeaders = {
      etag,
      vary: "Accept-Encoding",
      "cache-control": "no-store",
    };
    if (matchesEtag(headerValue(request, "if-none-match"), etag)) {
      return { status: 304, headers: baseHeaders, body: null };
    }

    if (!snapshotCache || snapshotCache.projectId !== projectId || snapshotCache.revision !== revision) {
      snapshotCache = {
        projectId,
        revision,
        body: Buffer.from(JSON.stringify({ ok: true, result })),
        compressed: new Map(),
      };
    }
    const encoding = selectContentEncoding(headerValue(request, "accept-encoding"));
    let body = snapshotCache.body;
    if (encoding) {
      body = await cachedCompressedBody(snapshotCache, encoding);
    }
    return {
      status: 200,
      headers: {
        ...baseHeaders,
        ...(encoding ? { "content-encoding": encoding } : {}),
        "content-type": "application/json; charset=utf-8",
        "content-length": String(body.byteLength),
      },
      body,
    };
  }

  return Object.freeze({
    matchRoute: (route) => matchUiRoute(route),
    parseQuery: (url, route) => parseUiQuery(url, route),
    read,
    readSnapshotResponse,
    projectUiResult: read,
  });
}

export { matchUiRoute, parseUiQuery };
