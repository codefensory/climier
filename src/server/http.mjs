import { createServer } from "node:http";

import { dispatchOperationRequest, validateOperationRequest } from "./http/operations.mjs";
import { createBuiltinOperationRegistry } from "../application/operations/builtins.mjs";
import { remoteV1Manifest } from "../application/operations/remote-v1-manifest.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { createHttpReads } from "./http/reads.mjs";
import * as readModel from "../read-model/index.mjs";
import { readState } from "../storage/state.mjs";
import { initState } from "../kernel/state-operations.mjs";
import { authorizeAction as authorizeServerAction, loadApplicablePolicy } from "../plugins/policy.mjs";
import { withAuthorizedProject } from "./auth/project-scope.mjs";
import { createHttpCodec } from "./http/codec.mjs";
import { executeTransferRequest, validateTransferRequest } from "./http/transfers.mjs";

const PROTOCOL_VERSION = "1";
const { httpError, errorStatus, jsonError, send, parseProjectPath, readJsonBody } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
const reads = createHttpReads({
  httpError,
  routing: { decodeURIComponent },
  query: { searchParams: (url) => url.searchParams },
  deps: readModel,
  clock: Date.now,
});

export function createRemoteApiServer({
  catalog,
  credentials = [],
  openProject = async (projectDir) => ({ projectDir }),
  registry = createBuiltinOperationRegistry(),
  mutate: mutateKernel = mutate,
  selectPolicy,
  authorizeAction,
} = {}) {
  if (!catalog || typeof catalog.resolveProject !== "function") {
    throw new TypeError("server http: catalog.resolveProject is required");
  }
  if (typeof openProject !== "function") throw new TypeError("server http: openProject must be a function");
  if (!registry || typeof registry.lookup !== "function") throw new TypeError("server http: registry.lookup is required");
  if (typeof mutateKernel !== "function") throw new TypeError("server http: mutate must be a function");

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (!url.pathname.startsWith("/v1/")) {
        throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      }
      const version = request.headers["x-climier-protocol-version"];
      if (version !== PROTOCOL_VERSION) {
        throw httpError(
          "PROTOCOL_VERSION_UNSUPPORTED",
          `server http: protocol version '${version === undefined ? "missing" : version}' is not supported; expected '${PROTOCOL_VERSION}'`,
          { expected: PROTOCOL_VERSION, received: version === undefined ? null : version },
          426,
        );
      }
      const route = parseProjectPath(url.pathname);
      if (!route) throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      const operationRoute = route.route === "operations" && request.method === "POST";
      const initRoute = route.route === "init" && request.method === "POST";
      const transferRoute = new Set(["transfer/export", "transfer/import"]).has(route.route) && request.method === "POST";
      const read = request.method === "GET" ? reads.matchReadRoute(route.route) : null;
      if (!read && !operationRoute && !initRoute && !transferRoute) {
        if (route.route.startsWith("files/") || route.route === "snapshot" || route.route === "read/snapshot") {
          throw httpError("ROUTE_NOT_FOUND", "server http: generic file and snapshot routes are not available", undefined, 404);
        }
        throw httpError("ROUTE_NOT_FOUND", "server http: route was not found", undefined, 404);
      }
      let body = null;
      if (operationRoute) body = validateOperationRequest(await readJsonBody(request), { manifest: remoteV1Manifest, httpError });
      if (transferRoute) body = validateTransferRequest(await readJsonBody(request), route.route, httpError);
      if (initRoute) {
        body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw httpError("INVALID_REQUEST", "server http: init request must be a JSON object", { field: "body" }, 400);
        }
        for (const field of Object.keys(body)) {
          if (field === "force" || field === "reset") {
            const error = httpError("REMOTE_UNSUPPORTED_OPERATION", `server http: init option '${field}' is not supported remotely`, { field }, 400);
            throw error;
          }
          throw httpError("INVALID_REQUEST", `server http: init field '${field}' is not allowed`, { field }, 400);
        }
      }
      const query = read ? reads.parseReadQuery(url, read) : null;
      const project = await withAuthorizedProject({
        authorization: request.headers.authorization,
        projectId: route.projectId,
        credentials,
        catalog,
        openProject,
        provision: initRoute,
      });
      if (!project || typeof project.projectDir !== "string") {
        throw httpError("PROJECT_OPEN_FAILED", "server http: project opener did not return a projectDir", undefined, 500);
      }

      if (transferRoute) {
        const result = await executeTransferRequest({ projectDir: project.projectDir, route: route.route, body });
        send(response, 200, { ok: true, result });
        return;
      }

      if (initRoute) {
        let result;
        try {
          const mutation = await initState({ projectDir: project.projectDir, actor: "system" });
          result = mutation.result;
        } catch (error) {
          if (typeof error?.message === "string" && error.message.startsWith("state.init: state file already exists at ")) {
            throw httpError("STATE_ALREADY_INITIALIZED", "server http: project state is already initialized", undefined, 409);
          }
          throw error;
        }
        send(response, 200, { ok: true, result });
        return;
      }

      if (operationRoute) {
        const source = {
          registry,
          mutate: mutateKernel,
          selectPolicy: selectPolicy || loadApplicablePolicy,
          authorizeAction: authorizeAction || authorizeServerAction,
        };
        const result = await dispatchOperationRequest({
          projectDir: project.projectDir,
          body,
          source,
          manifest: remoteV1Manifest,
        });
        send(response, 200, { ok: true, result });
        return;
      }

      const snapshot = await readState(project.projectDir);
      if (!snapshot) {
        throw httpError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
      }
      send(response, 200, { ok: true, result: reads.projectReadResult({ snapshot, route: read, query }) });
    } catch (error) {
      if (!response.headersSent) send(response, errorStatus(error), jsonError(error));
      else response.destroy(error);
    }
  });
}

export { PROTOCOL_VERSION };
