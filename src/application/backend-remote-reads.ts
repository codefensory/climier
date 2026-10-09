import type { CodedApplicationError, ProjectConfig, RemoteRequest } from "./types.ts";
import { isRecord } from "./types.ts";

type ReadOption = string | boolean | number | null | undefined;
type ReadOptions = Record<string, ReadOption>;
type ReadTypeKind = "string" | "boolean" | "non-negative-integer" | "non-negative-number";
type ReadType = { kind: ReadTypeKind; nullable?: boolean };

function clientError(code: string, message: string, details?: Record<string, unknown>): CodedApplicationError {
  const error = new Error(message) as CodedApplicationError;
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function invalidReadRequest(method: string, message: string, field?: string): CodedApplicationError {
  return clientError("INVALID_REQUEST", `application.backendClient: ${method} ${message}`, field ? { field } : undefined);
}

function readOptions(method: string, options: unknown, allowed: readonly string[]): ReadOptions {
  if (!isRecord(options)) {
    throw invalidReadRequest(method, "options must be an object", "options");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {throw invalidReadRequest(method, `option '${key}' is not supported`, key);}
  }
  return options as ReadOptions;
}

function isValidReadValue(value: ReadOption, type: ReadType): boolean {
  const validators: Record<ReadTypeKind, (item: ReadOption) => boolean> = {
    string: (item) => typeof item === "string",
    boolean: (item) => typeof item === "boolean",
    "non-negative-integer": (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
    "non-negative-number": (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  };
  return validators[type.kind](value);
}

function validateReadOptions(method: string, options: ReadOptions, types: Record<string, ReadType>): void {
  for (const [name, type] of Object.entries(types)) {
    const value = options[name];
    if (value === undefined || (value === null && type.nullable)) {continue;}
    if (!isValidReadValue(value, type)) {throw invalidReadRequest(method, `option '${name}' has an invalid value`, name);}
  }
}

function readId(method: string, options: ReadOptions): string {
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw invalidReadRequest(method, "node id is required", "id");
  }
  return options.id;
}

function readQuery(options: ReadOptions, mapping: readonly (readonly [string, string])[]): string {
  const query = new URLSearchParams();
  for (const [option, parameter] of mapping) {
    const value = options[option];
    if (value === undefined || value === null) {continue;}
    query.set(parameter, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function getRead<T>({
  method,
  options,
  allowed,
  types,
  route,
  idRequired = false,
}: {
  method: string;
  options: unknown;
  allowed: readonly string[];
  types: Record<string, ReadType>;
  route: (options: ReadOptions) => T;
  idRequired?: boolean;
}): T {
  const read = readOptions(method, options, allowed);
  if (idRequired) {readId(method, read);}
  validateReadOptions(method, read, types);
  return route(read);
}

function statusReadType(key: string): ReadTypeKind {
  if (key === "staleMs" || key === "limit") {return "non-negative-integer";}
  if (key === "all") {return "boolean";}
  return "string";
}

function readStatus(request: RemoteRequest, options: unknown): Promise<unknown> {
  const allowed = ["initiative", "kind", "status", "domain", "claimedBy", "staleMs", "limit", "all", "as"];
  const types = Object.fromEntries(allowed.map((key) => [key, { kind: statusReadType(key) }])) as Record<string, ReadType>;
  return getRead({
    method: "readStatus", options, allowed, types,
    route: (value) => request({ method: "GET", route: `read/status${readQuery(value, [
      ["initiative", "initiative"], ["kind", "kind"], ["status", "status"], ["domain", "domain"],
      ["claimedBy", "claimed-by"], ["staleMs", "stale-ms"], ["limit", "limit"], ["all", "all"], ["as", "as"],
    ])}` }),
  });
}

function readContext(request: RemoteRequest, options: unknown): Promise<unknown> {
  const id = getRead({
    method: "readContext", options, allowed: ["id", "as", "staleMs"], idRequired: true,
    types: { as: { kind: "string" }, staleMs: { kind: "non-negative-number" } },
    route: (value) => readId("readContext", value),
  });
  return request({ method: "GET", route: `read/context/${encodeURIComponent(id)}${readQuery(options as ReadOptions, [["as", "as"], ["staleMs", "staleMs"]])}` });
}

function readNode(request: RemoteRequest, options: unknown): Promise<unknown> {
  const id = getRead({ method: "readNode", options, allowed: ["id"], idRequired: true, types: {}, route: (value) => readId("readNode", value) });
  return request({ method: "GET", route: `read/show/${encodeURIComponent(id)}` });
}

function readHistory(request: RemoteRequest, options: unknown): Promise<unknown> {
  const id = getRead({
    method: "readHistory", options, allowed: ["id", "limit"], idRequired: true,
    types: { limit: { kind: "non-negative-integer" } }, route: (value) => readId("readHistory", value),
  });
  return request({ method: "GET", route: `read/history/${encodeURIComponent(id)}${readQuery(options as ReadOptions, [["limit", "limit"]])}` });
}

function readSearch(request: RemoteRequest, options: unknown): Promise<unknown> {
  return getRead({
    method: "readSearch", options, allowed: ["query", "all"],
    types: { query: { kind: "string" }, all: { kind: "boolean" } },
    route: (value) => request({ method: "GET", route: `read/search${readQuery(value, [["query", "query"], ["all", "all"]])}` }),
  });
}

function readInitiatives(request: RemoteRequest, options: unknown): Promise<unknown> {
  return getRead({
    method: "readInitiatives", options, allowed: ["all"], types: { all: { kind: "boolean" } },
    route: (value) => request({ method: "GET", route: `read/initiatives${readQuery(value, [["all", "all"]])}` }),
  });
}

function readLog(request: RemoteRequest, options: unknown): Promise<unknown> {
  const allowed = ["limit", "action", "agent", "node"];
  const types = Object.fromEntries(allowed.map((key) => [key, { kind: key === "limit" ? "non-negative-integer" : "string" }])) as Record<string, ReadType>;
  return getRead({
    method: "readLog", options, allowed, types,
    route: (value) => request({ method: "GET", route: `read/log${readQuery(value, allowed.map((key) => [key, key]))}` }),
  });
}

export function createRemoteReadMethods(request: RemoteRequest): {
  readStatus: (options?: ReadOptions) => Promise<unknown>;
  readContext: (options?: ReadOptions) => Promise<unknown>;
  readNode: (options?: ReadOptions) => Promise<unknown>;
  readHistory: (options?: ReadOptions) => Promise<unknown>;
  readSearch: (options?: ReadOptions) => Promise<unknown>;
  readInitiatives: (options?: ReadOptions) => Promise<unknown>;
  readLog: (options?: ReadOptions) => Promise<unknown>;
  readState: () => Promise<unknown>;
} {
  return {
    readStatus: (options: ReadOptions = {}) => readStatus(request, options),
    readContext: (options: ReadOptions = {}) => readContext(request, options),
    readNode: (options: ReadOptions = {}) => readNode(request, options),
    readHistory: (options: ReadOptions = {}) => readHistory(request, options),
    readSearch: (options: ReadOptions = {}) => readSearch(request, options),
    readInitiatives: (options: ReadOptions = {}) => readInitiatives(request, options),
    readLog: (options: ReadOptions = {}) => readLog(request, options),
    readState: () => request({ method: "GET", route: "read/state" }),
  };
}
