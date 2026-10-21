import fs from "node:fs";
import path from "node:path";

 type WatcherListener = (revision: number) => void;
type WatcherOptions = {
  statePath?: string;
  resolveState?: () => string | Promise<string>;
  pollIntervalMs?: number;
  watchFactory?: typeof fs.watch;
  readRevision?: (file: string) => Promise<number | null | undefined>;
  onError?: (error: unknown) => void;
};

type Watcher = {
  readonly currentRevision: number | undefined;
  readonly closed: boolean;
  readonly listening: boolean;
  start: () => Promise<number | undefined>;
  poll: (emit?: boolean) => Promise<number | undefined>;
  close: () => Promise<void>;
  subscribe: (listener: WatcherListener) => () => boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 250;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`server revision watcher: ${name} must be a positive integer`);
  }
}

function missing(error) {
  return error?.code === "ENOENT";
}

async function readSqliteRevision(file: string) {
  const { readSqliteState } = await import("../../storage/sqlite/store.ts");
  const state = await readSqliteState(file, { includeBodies: false });
  return Number.isSafeInteger(state?.revision) ? state.revision : null;
}

/** Observe the revision stored in a project's SQLite database. */
export function createRevisionWatcher({
  statePath,
  resolveState,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  watchFactory = fs.watch,
  readRevision = readSqliteRevision,
  onError,
}: WatcherOptions = {}): Watcher {
  if (statePath !== undefined && (typeof statePath !== "string" || !statePath)) {
    throw new TypeError("server revision watcher: statePath must be a non-empty path");
  }
  if (resolveState !== undefined && typeof resolveState !== "function") {
    throw new TypeError("server revision watcher: resolveState must be a function");
  }
  if (statePath === undefined && resolveState === undefined) {
    throw new TypeError("server revision watcher: statePath or resolveState is required");
  }
  assertPositiveInteger(pollIntervalMs, "pollIntervalMs");
  if (typeof watchFactory !== "function") throw new TypeError("server revision watcher: watchFactory must be a function");
  if (typeof readRevision !== "function") throw new TypeError("server revision watcher: readRevision must be a function");
  if (onError !== undefined && typeof onError !== "function") throw new TypeError("server revision watcher: onError must be a function");

  const listeners = new Set<WatcherListener>();
  let currentRevision;
  let currentDirectory;
  let directoryWatcher;
  let interval;
  let wakeup;
  let pollPromise;
  let startPromise;
  let running = false;
  let closed = false;

  const reportError = (error) => { if (onError) onError(error); };
  const resolveStatePath = async () => {
    const resolved = resolveState ? await resolveState() : statePath;
    if (typeof resolved !== "string" || !resolved) throw new TypeError("server revision watcher: resolveState returned an invalid path");
    return path.resolve(resolved);
  };
  const closeDirectoryWatcher = () => {
    if (!directoryWatcher) return;
    directoryWatcher.close();
    directoryWatcher = undefined;
    currentDirectory = undefined;
  };
  const watchDirectory = (directory) => {
    if (directoryWatcher && currentDirectory === directory) return;
    closeDirectoryWatcher();
    currentDirectory = directory;
    try {
      directoryWatcher = watchFactory(directory, () => {
        if (closed || wakeup) return;
        wakeup = setTimeout(() => {
          wakeup = undefined;
          void poll().catch(reportError);
        }, 0);
        wakeup.unref?.();
      });
    } catch (error) {
      currentDirectory = undefined;
      reportError(error);
    }
  };

  const poll = async (emit = true) => {
    if (closed) return currentRevision;
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      const file = await resolveStatePath();
      watchDirectory(path.dirname(file));
      let revision;
      try { revision = await readRevision(file); }
      catch (error) { if (missing(error)) return currentRevision; throw error; }
      if (revision === null || revision === undefined) return currentRevision;
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error(`server revision watcher: SQLite state at ${file} has no valid revision`);
      }
      if (currentRevision === undefined) {
        currentRevision = revision;
      } else if (emit && currentRevision !== revision) {
        currentRevision = revision;
        for (const listener of [...listeners]) listener(revision);
      } else {
        currentRevision = revision;
      }
      return currentRevision;
    })();
    try { return await pollPromise; }
    finally { pollPromise = undefined; }
  };

  const start = async () => {
    if (closed) throw new Error("server revision watcher: watcher is closed");
    if (running) return startPromise;
    running = true;
    startPromise = poll(false).then(() => {
      if (closed) return currentRevision;
      interval = setInterval(() => void poll().catch(reportError), pollIntervalMs);
      interval.unref?.();
      return currentRevision;
    }).catch((error) => {
      running = false;
      startPromise = undefined;
      throw error;
    });
    return startPromise;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (wakeup) clearTimeout(wakeup);
    if (interval) clearInterval(interval);
    interval = undefined;
    if (startPromise) await startPromise.catch(() => {});
    if (pollPromise) await pollPromise.catch(() => {});
    closeDirectoryWatcher();
    listeners.clear();
  };

  return {
    get currentRevision() { return currentRevision; },
    get closed() { return closed; },
    get listening() { return running && !closed; },
    start,
    poll,
    close,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("server revision watcher: listener must be a function");
      if (closed) throw new Error("server revision watcher: watcher is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
