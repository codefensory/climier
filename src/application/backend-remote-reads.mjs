function clientError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function invalidReadRequest(method, message, field) {
  return clientError("INVALID_REQUEST", `application.backendClient: ${method} ${message}`, field ? { field } : undefined);
}

function readOptions(method, options, allowed) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalidReadRequest(method, "options must be an object", "options");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {throw invalidReadRequest(method, `option '${key}' is not supported`, key);}
  }
  return options;
}

function isValidReadValue(value, type) {
  const validators = {
    string: (item) => typeof item === "string",
    boolean: (item) => typeof item === "boolean",
    "non-negative-integer": (item) => Number.isSafeInteger(item) && item >= 0,
    "non-negative-number": (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  };
  return validators[type.kind]?.(value) ?? false;
}

function validateReadOptions(method, options, types) {
  for (const [name, type] of Object.entries(types)) {
    const value = options[name];
    if (value === undefined || (value === null && type.nullable)) {continue;}
    if (!isValidReadValue(value, type)) {throw invalidReadRequest(method, `option '${name}' has an invalid value`, name);}
  }
}

function readId(method, options) {
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw invalidReadRequest(method, "node id is required", "id");
  }
  return options.id;
}

function readQuery(options, mapping) {
  const query = new URLSearchParams();
  for (const [option, parameter] of mapping) {
    const value = options[option];
    if (value === undefined || value === null) {continue;}
    query.set(parameter, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function getRead({ method, options, allowed, types, route, idRequired = false }) {
  readOptions(method, options, allowed);
  if (idRequired) {readId(method, options);}
  validateReadOptions(method, options, types);
  return route(options);
}

function statusReadType(key) {
  if (key === "staleMs" || key === "limit") {return "non-negative-integer";}
  if (key === "all") {return "boolean";}
  return "string";
}

function readStatus(request, options) {
  const allowed = ["initiative", "kind", "status", "domain", "claimedBy", "staleMs", "limit", "all", "as"];
  const types = Object.fromEntries(allowed.map((key) => [key, { kind: statusReadType(key) }]));
  return getRead({
    method: "readStatus", options, allowed, types,
    route: (value) => request({ method: "GET", route: `read/status${readQuery(value, [
      ["initiative", "initiative"], ["kind", "kind"], ["status", "status"], ["domain", "domain"],
      ["claimedBy", "claimed-by"], ["staleMs", "stale-ms"], ["limit", "limit"], ["all", "all"], ["as", "as"],
    ])}` }),
  });
}

function readContext(request, options) {
  const id = getRead({
    method: "readContext", options, allowed: ["id", "as", "staleMs"], idRequired: true,
    types: { as: { kind: "string" }, staleMs: { kind: "non-negative-number" } },
    route: () => readId("readContext", options),
  });
  return request({ method: "GET", route: `read/context/${encodeURIComponent(id)}${readQuery(options, [["as", "as"], ["staleMs", "staleMs"]])}` });
}

function readNode(request, options) {
  const id = getRead({ method: "readNode", options, allowed: ["id"], idRequired: true, types: {}, route: () => readId("readNode", options) });
  return request({ method: "GET", route: `read/show/${encodeURIComponent(id)}` });
}

function readHistory(request, options) {
  const id = getRead({
    method: "readHistory", options, allowed: ["id", "limit"], idRequired: true,
    types: { limit: { kind: "non-negative-integer" } }, route: () => readId("readHistory", options),
  });
  return request({ method: "GET", route: `read/history/${encodeURIComponent(id)}${readQuery(options, [["limit", "limit"]])}` });
}

function readSearch(request, options) {
  return getRead({
    method: "readSearch", options, allowed: ["query", "all"],
    types: { query: { kind: "string" }, all: { kind: "boolean" } },
    route: (value) => request({ method: "GET", route: `read/search${readQuery(value, [["query", "query"], ["all", "all"]])}` }),
  });
}

function readInitiatives(request, options) {
  return getRead({
    method: "readInitiatives", options, allowed: ["all"], types: { all: { kind: "boolean" } },
    route: (value) => request({ method: "GET", route: `read/initiatives${readQuery(value, [["all", "all"]])}` }),
  });
}

function readLog(request, options) {
  const allowed = ["limit", "action", "agent", "task", "decision"];
  const types = Object.fromEntries(allowed.map((key) => [key, { kind: key === "limit" ? "non-negative-integer" : "string" }]));
  return getRead({
    method: "readLog", options, allowed, types,
    route: (value) => request({ method: "GET", route: `read/log${readQuery(value, allowed.map((key) => [key, key]))}` }),
  });
}

export function createRemoteReadMethods(request) {
  return {
    readStatus: (options = {}) => readStatus(request, options),
    readContext: (options = {}) => readContext(request, options),
    readNode: (options = {}) => readNode(request, options),
    readHistory: (options = {}) => readHistory(request, options),
    readSearch: (options = {}) => readSearch(request, options),
    readInitiatives: (options = {}) => readInitiatives(request, options),
    readLog: (options = {}) => readLog(request, options),
    readState: () => request({ method: "GET", route: "read/state" }),
  };
}
