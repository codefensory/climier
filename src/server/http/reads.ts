type ReadRoute = { kind: string; id?: string; query?: string; allowedQuery: readonly string[] };
type ReadDependencies = {
  httpError: (code: string, message: string, details?: unknown, status?: number) => Error;
  routing: { decodeURIComponent: (value: string) => string };
  query: { searchParams: (url: URL) => Iterable<[string, string]> };
  deps: Record<string, (args?: unknown) => unknown>;
  clock?: () => number;
};

type ReadOptions = Partial<ReadDependencies>;

const READ_ROUTES: readonly [string, RegExp, readonly string[]][] = [
  ["status", /^read\/status$/, ["initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as"]],
  ["context", /^read\/context\/([^/]+)$/, ["as", "staleMs"]],
  ["show", /^read\/show\/([^/]+)$/, []],
  ["history", /^read\/history\/([^/]+)$/, ["limit"]],
  ["search", /^read\/search(?:\/([^/]+))?$/, ["query", "all"]],
  ["initiatives", /^read\/initiatives$/, ["all"]],
  ["log", /^read\/log$/, ["limit", "action", "agent", "node"]],
  ["state", /^read\/state$/, []],
  ["node", /^read\/nodes\/([^/]+)$/, []],
];

function requireDependencies({ httpError, routing, query, deps, clock }) {
  const requirements = [
    [typeof httpError === "function", "httpError is required"],
    [typeof routing?.decodeURIComponent === "function", "routing.decodeURIComponent is required"],
    [typeof query?.searchParams === "function", "query.searchParams is required"],
    [typeof deps?.projectStatusView === "function", "read-model dependencies are required"],
    [typeof clock === "function", "clock must be a function"],
  ];
  const missing = requirements.find(([valid]) => !valid);
  if (missing) {
    throw new TypeError(`server http reads: ${missing[1]}`);
  }
}

function matchReadRoute(route: string, routing: ReadDependencies["routing"], httpError: ReadDependencies["httpError"]): ReadRoute | null {
  for (const [kind, pattern, allowedQuery] of READ_ROUTES) {
    const match = pattern.exec(route);
    if (!match) {
      continue;
    }
    if (match[1] === undefined) {
      return { kind, allowedQuery };
    }
    let id;
    try {
      id = routing.decodeURIComponent(match[1]);
    } catch {
      throw httpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
    }
    if (kind === "search") {
      return { kind, id, query: id, allowedQuery };
    }
    return { kind, id, allowedQuery };
  }
  return null;
}

function invalidQuery(httpError, message, details) {
  throw httpError("INVALID_QUERY", `server http: ${message}`, details, 400);
}

function parseAll(parsed, httpError) {
  if (!Object.hasOwn(parsed, "all")) {
    return;
  }
  if (parsed.all === "") {
    parsed.all = true;
    return;
  }
  if (parsed.all !== "true" && parsed.all !== "false") {
    invalidQuery(httpError, "query parameter 'all' must be true or false", { parameter: "all", value: parsed.all });
  }
  parsed.all = parsed.all === "true";
}

function parseNonNegativeInt(parsed, name, httpError, options: { number?: boolean } = {}) {
  const { number = false } = options;
  if (!Object.hasOwn(parsed, name)) {
    return;
  }
  const value = parsed[name];
  const valueAsNumber = number ? Number(value) : parseInt(value, 10);
  const invalid = !Number.isFinite(valueAsNumber) || valueAsNumber < 0;
  if (invalid) {
    invalidQuery(httpError, `query parameter '${name}' must be a non-negative ${number ? "number" : "integer"}`, { parameter: name, value });
  }
  parsed[name] = valueAsNumber;
}

function parseRouteNumbers(parsed, kind, httpError) {
  if (kind === "status") {
    parseNonNegativeInt(parsed, "stale-ms", httpError);
    parseNonNegativeInt(parsed, "limit", httpError);
  } else if (kind === "context") {
    parseNonNegativeInt(parsed, "staleMs", httpError, { number: true });
  } else if (kind === "history" || kind === "log") {
    parseNonNegativeInt(parsed, "limit", httpError);
  }
}

function parseSearchQuery(parsed, route, httpError) {
  if (route.kind !== "search") {
    return;
  }
  if (route.query !== undefined && Object.hasOwn(parsed, "query")) {
    invalidQuery(httpError, "search query must not be repeated in the path and query string", { parameter: "query" });
  }
  parsed.query = route.query ?? parsed.query ?? "";
}

function parseReadQuery(url, route, query, httpError) {
  const parsed = {};
  for (const [key, value] of query.searchParams(url)) {
    if (!route.allowedQuery.includes(key)) {
      invalidQuery(httpError, `query parameter '${key}' is not allowed for ${route.kind}`, { parameter: key });
    }
    if (Object.hasOwn(parsed, key)) {
      invalidQuery(httpError, `query parameter '${key}' must not be repeated`, { parameter: key });
    }
    parsed[key] = value;
  }
  parseSearchQuery(parsed, route, httpError);
  parseAll(parsed, httpError);
  parseRouteNumbers(parsed, route.kind, httpError);
  return parsed;
}

function entryReferencesId(entry, id) {
  if (!entry || !id) {
    return false;
  }
  const directReferences = new Set([entry.node]);
  const hasDirectReference = directReferences.has(id);
  const hasNoteReference = typeof entry.note === "string" && entry.note.split(/\\s+/).includes(id);
  return hasDirectReference || hasNoteReference;
}

function getNode(nodes, id, httpError) {
  const node = nodes[id];
  if (!node) {
    throw httpError("NODE_NOT_FOUND", `server http: node '${id}' was not found`, { id }, 404);
  }
  return node;
}

function projectStatus(snapshot, filters, now, deps) {
  return deps.projectStatusView({ snapshot, filters, now });
}

function projectContext(snapshot, id, filters, { now, deps, httpError }) {
  const view = deps.projectContextView({ snapshot, id, agent: filters.as, staleMs: filters.staleMs, now });
  if (!view) {
    throw httpError("NODE_NOT_FOUND", `server http: node '${id}' was not found`, { id }, 404);
  }
  return view;
}

function projectHistory(snapshot, id, filters) {
  let entries = (snapshot.log || []).filter((entry) => entryReferencesId(entry, id));
  if (filters.limit > 0) {
    entries = entries.slice(-filters.limit);
  }
  return { id, entries };
}

function projectShow(snapshot, id, httpError) {
  const node = getNode(snapshot.nodes || {}, id, httpError);
  return { type: node.subkind || node.kind, node: structuredClone(node) };
}

function projectNode(snapshot, id, deps, httpError) {
  const node = getNode(snapshot.nodes || {}, id, httpError);
  return {
    node: structuredClone(node),
    derived_status: deps.statusOf({ snapshot, id }),
    blocking: deps.blockingForNode({ snapshot, id }),
    knowledge: deps.knowledgeForNode({ snapshot, id }),
    informing: deps.informingForNode({ snapshot, id }),
  };
}

function projectSearch(snapshot, filters, deps) {
  return deps.projectSearchView({ snapshot, query: filters.query, all: filters.all === true });
}

function projectInitiatives(snapshot, filters, deps) {
  return deps.projectInitiativesView({ snapshot, all: filters.all === true });
}

function createProjectors({ deps, httpError }) {
  return {
    status: (snapshot, route, filters, now) => projectStatus(snapshot, filters, now, deps),
    context: (snapshot, route, filters, now) => projectContext(snapshot, route.id, filters, { now, deps, httpError }),
    show: (snapshot, route) => projectShow(snapshot, route.id, httpError),
    history: (snapshot, route, filters) => projectHistory(snapshot, route.id, filters),
    search: (snapshot, route, filters) => projectSearch(snapshot, filters, deps),
    initiatives: (snapshot, route, filters) => projectInitiatives(snapshot, filters, deps),
    log: (snapshot, route, filters) => deps.projectLogView({ snapshot, filters }),
    state: (snapshot) => deps.projectSnapshot({ snapshot }),
    node: (snapshot, route) => projectNode(snapshot, route.id, deps, httpError),
  };
}

function projectReadResult({ snapshot, route, query: filters, now }, projectors) {
  const project = projectors[route.kind] || projectors.node;
  return project(snapshot, route, filters, now);
}

export function createHttpReads({ httpError, routing, query, deps, clock = Date.now }: ReadOptions = {}) {
  requireDependencies({ httpError, routing, query, deps, clock });
  const projectors = createProjectors({ deps, httpError });
  return {
    matchReadRoute: (route) => matchReadRoute(route, routing!, httpError!),
    parseReadQuery: (url, route) => parseReadQuery(url, route, query, httpError),
    projectReadResult: (input) => projectReadResult({ ...input, now: input.now ?? clock() }, projectors),
  };
}
