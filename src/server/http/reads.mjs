const READ_ROUTES = [
  ["status", /^read\/status$/, ["initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as"]],
  ["context", /^read\/context\/([^/]+)$/, ["as", "staleMs"]],
  ["show", /^read\/show\/([^/]+)$/, []],
  ["history", /^read\/history\/([^/]+)$/, ["limit"]],
  ["search", /^read\/search(?:\/([^/]+))?$/, ["query", "all"]],
  ["initiatives", /^read\/initiatives$/, ["all"]],
  ["log", /^read\/log$/, ["limit", "action", "agent", "task", "decision"]],
  ["state", /^read\/state$/, []],
  ["node", /^read\/nodes\/([^/]+)$/, []],
];

export function createHttpReads({ httpError, routing, query, deps, clock = Date.now } = {}) {
  if (typeof httpError !== "function") throw new TypeError("server http reads: httpError is required");
  if (!routing || typeof routing.decodeURIComponent !== "function") throw new TypeError("server http reads: routing.decodeURIComponent is required");
  if (!query || typeof query.searchParams !== "function") throw new TypeError("server http reads: query.searchParams is required");
  if (!deps || typeof deps.projectStatusView !== "function") throw new TypeError("server http reads: read-model dependencies are required");
  if (typeof clock !== "function") throw new TypeError("server http reads: clock must be a function");

  function matchReadRoute(route) {
    for (const [kind, pattern, allowedQuery] of READ_ROUTES) {
      const match = pattern.exec(route);
      if (!match) continue;
      if (match[1] === undefined) return { kind, allowedQuery };
      let id;
      try {
        id = routing.decodeURIComponent(match[1]);
      } catch {
        throw httpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
      }
      if (kind === "search") return { kind, id, query: id, allowedQuery };
      return { kind, id, allowedQuery };
    }
    return null;
  }

  function invalidQuery(message, details) {
    throw httpError("INVALID_QUERY", `server http: ${message}`, details, 400);
  }

  function parseReadQuery(url, route) {
    const params = query.searchParams(url);
    const parsed = {};
    for (const [key, value] of params) {
      if (!route.allowedQuery.includes(key)) invalidQuery(`query parameter '${key}' is not allowed for ${route.kind}`, { parameter: key });
      if (Object.hasOwn(parsed, key)) invalidQuery(`query parameter '${key}' must not be repeated`, { parameter: key });
      parsed[key] = value;
    }
    if (route.kind === "search") {
      if (route.query !== undefined && Object.hasOwn(parsed, "query")) invalidQuery("search query must not be repeated in the path and query string", { parameter: "query" });
      parsed.query = route.query ?? parsed.query ?? "";
    }
    if (Object.hasOwn(parsed, "all")) {
      if (parsed.all === "") parsed.all = true;
      else {
        if (parsed.all !== "true" && parsed.all !== "false") invalidQuery("query parameter 'all' must be true or false", { parameter: "all", value: parsed.all });
        parsed.all = parsed.all === "true";
      }
    }
    const parseNonNegativeInt = (name, { number = false } = {}) => {
      if (!Object.hasOwn(parsed, name)) return;
      const value = parsed[name];
      const valueAsNumber = number ? Number(value) : parseInt(value, 10);
      if (!Number.isFinite(valueAsNumber) || valueAsNumber < 0 || (!number && Number.isNaN(valueAsNumber))) {
        invalidQuery(`query parameter '${name}' must be a non-negative ${number ? "number" : "integer"}`, { parameter: name, value });
      }
      parsed[name] = valueAsNumber;
    };
    if (route.kind === "status") {
      parseNonNegativeInt("stale-ms");
      parseNonNegativeInt("limit");
    } else if (route.kind === "context") {
      parseNonNegativeInt("staleMs", { number: true });
    } else if (route.kind === "history" || route.kind === "log") {
      parseNonNegativeInt("limit");
    }
    return parsed;
  }

  function statusProjection(snapshot, filters, now) {
    return deps.projectStatusView({ snapshot, filters, now });
  }

  function contextProjection(snapshot, id, filters, now) {
    const view = deps.projectContextView({ snapshot, id, agent: filters.as, staleMs: filters.staleMs, now });
    if (!view) throw httpError("NODE_NOT_FOUND", `server http: node '${id}' was not found`, { id }, 404);
    return view;
  }

  function entryReferencesId(entry, id) {
    return !!entry && !!id && (entry.node === id || entry.task === id || entry.decision === id || entry.gotcha === id
      || (typeof entry.note === "string" && entry.note.split(/\\s+/).includes(id)));
  }

  function projectReadResult({ snapshot, route, query: filters, now = clock() }) {
    const nodes = snapshot.nodes || {};
    if (route.kind === "status") return statusProjection(snapshot, filters, now);
    if (route.kind === "context") return contextProjection(snapshot, route.id, filters, now);
    if (route.kind === "show") {
      const node = nodes[route.id];
      if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
      return { type: node.subkind || node.kind, node: structuredClone(node) };
    }
    if (route.kind === "history") {
      let entries = (snapshot.log || []).filter((entry) => entryReferencesId(entry, route.id));
      if (filters.limit > 0) entries = entries.slice(-filters.limit);
      return { id: route.id, entries };
    }
    if (route.kind === "search") return deps.projectSearchView({ snapshot, query: filters.query, all: filters.all === true });
    if (route.kind === "initiatives") return deps.projectInitiativesView({ snapshot, all: filters.all === true });
    if (route.kind === "log") return deps.projectLogView({ snapshot, filters });
    if (route.kind === "state") return deps.projectSnapshot({ snapshot });
    const node = nodes[route.id];
    if (!node) throw httpError("NODE_NOT_FOUND", `server http: node '${route.id}' was not found`, { id: route.id }, 404);
    return { node: structuredClone(node), derived_status: deps.statusOf({ snapshot, id: route.id }), blocking: deps.blockingForNode({ snapshot, id: route.id }), knowledge: deps.knowledgeForNode({ snapshot, id: route.id }), informing: deps.informingForNode({ snapshot, id: route.id }) };
  }

  return { matchReadRoute, parseReadQuery, projectReadResult };
}

