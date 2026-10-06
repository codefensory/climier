import { createRevisionWatcher } from "../ui/revision-watcher.ts";

const DEFAULT_HEARTBEAT_MS = 15_000;

function uiError(code, message, details, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function projectWithId(project, projectId) {
  if (project && typeof project === "object") {
    return { ...project, id: project.id ?? project.project_id ?? projectId };
  }
  return { id: projectId, name: projectId, value: project };
}

function assertDependencies({ getProject, authorize, readSnapshot }) {
  for (const [value, message] of [
    [getProject, "getProject must be a function"],
    [authorize, "authorize must be a function"],
    [readSnapshot, "readSnapshot must be a function"],
  ]) {
    if (typeof value !== "function") throw new TypeError(`server http ui events: ${message}`);
  }
}

function assertInterval(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`server http ui events: ${name} must be a positive integer`);
  }
}

function write(response, data) {
  if (response.destroyed || response.writableEnded) return false;
  response.write(data);
  return true;
}

export function createUiEvents({
  getProject,
  authorize,
  readSnapshot,
  createWatcher = (options) => createRevisionWatcher(options),
  resolveLedger,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  pollIntervalMs,
  protocolVersion = "1",
} = {}) {
  assertDependencies({ getProject, authorize, readSnapshot });
  if (typeof createWatcher !== "function") throw new TypeError("server http ui events: createWatcher must be a function");
  if (resolveLedger !== undefined && typeof resolveLedger !== "function") {
    throw new TypeError("server http ui events: resolveLedger must be a function");
  }
  assertInterval(heartbeatMs, "heartbeatMs");
  if (pollIntervalMs !== undefined) assertInterval(pollIntervalMs, "pollIntervalMs");
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new TypeError("server http ui events: protocolVersion must be a non-empty string");
  }

  const projects = new Map();
  const connections = new Set();

  function matchRoute(route) {
    return route === "ui/events" ? { kind: "events" } : null;
  }

  function getProjectEntry(projectId, project) {
    let entry = projects.get(projectId);
    if (entry) return entry;
    const watcherOptions = {
      projectDir: project.projectDir,
      ...(resolveLedger === undefined ? {} : {
        resolveLedger: () => resolveLedger({ projectId, project, projectDir: project.projectDir }),
      }),
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    };
    const watcher = createWatcher(watcherOptions);
    entry = { projectId, watcher, connections: new Set(), startPromise: null };
    projects.set(projectId, entry);
    return entry;
  }

  function releaseConnection(connection) {
    if (connection.released) return;
    connection.released = true;
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    connection.unsubscribe?.();
    connection.entry.connections.delete(connection);
    connections.delete(connection);
    if (connection.entry.connections.size === 0) {
      projects.delete(connection.entry.projectId);
      void connection.entry.watcher.close();
    }
  }

  function closeConnection(connection) {
    releaseConnection(connection);
    if (!connection.response.writableEnded && !connection.response.destroyed) {
      connection.response.end();
    }
  }

  async function handle({ request, response, projectId } = {}) {
    await authorize(request, { projectId });
    const project = await getProject(projectId, { request });
    if (!project) {
      throw uiError("UNKNOWN_PROJECT", "server http: project is not provisioned", { projectId }, 404);
    }
    const resolvedProject = projectWithId(project, projectId);
    const snapshot = await readSnapshot(resolvedProject, { request, projectId });
    if (!snapshot) {
      throw uiError("STATE_NOT_INITIALIZED", "server http: project state is not initialized", undefined, 409);
    }

    const entry = getProjectEntry(projectId, resolvedProject);
    const connection = { entry, response, released: false, heartbeat: null, unsubscribe: null };
    entry.connections.add(connection);
    connections.add(connection);
    connection.unsubscribe = entry.watcher.subscribe((revision) => {
      if (!connection.released) write(response, `data: ${JSON.stringify({ revision })}\n\n`);
    });

    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
      "x-climier-protocol-version": protocolVersion,
    });
    response.flushHeaders?.();
    write(response, ": heartbeat\n\n");
    connection.heartbeat = setInterval(() => write(response, ": heartbeat\n\n"), heartbeatMs);
    connection.heartbeat.unref?.();
    response.once("close", () => releaseConnection(connection));
    response.once("error", () => releaseConnection(connection));
    request.once?.("aborted", () => closeConnection(connection));

    try {
      if (!entry.startPromise) {
        entry.startPromise = Promise.resolve().then(() => entry.watcher.start());
      }
      await entry.startPromise;
    } catch (error) {
      closeConnection(connection);
      throw error;
    }
    return { close: () => closeConnection(connection) };
  }

  async function close() {
    for (const connection of [...connections]) closeConnection(connection);
    await Promise.all([...projects.values()].map((entry) => entry.watcher.close()));
    projects.clear();
  }

  return Object.freeze({ handle, matchRoute, close });
}
