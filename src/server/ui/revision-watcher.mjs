import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 250;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`server revision watcher: ${name} must be a positive integer`);
  }
}

function revisionFromLedger(raw, ledgerPath) {
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`server revision watcher: ledger at ${ledgerPath} is not valid JSON`);
    error.cause = cause;
    throw error;
  }
  if (!Number.isSafeInteger(ledger?.high_water_revision) || ledger.high_water_revision < 1) {
    throw new Error(`server revision watcher: ledger at ${ledgerPath} has no valid high_water_revision`);
  }
  return ledger.high_water_revision;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

/**
 * Observe a project's revision ledger. Filesystem notifications only wake the
 * poll; the ledger remains the authoritative source of the revision.
 */
export function createRevisionWatcher({
  projectDir,
  ledgerPath,
  resolveLedger,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  watchFactory = fs.watch,
  readFile = (file) => fsp.readFile(file, "utf8"),
  onError,
} = {}) {
  if (typeof projectDir !== "undefined" && (typeof projectDir !== "string" || projectDir.length === 0)) {
    throw new TypeError("server revision watcher: projectDir must be a non-empty path");
  }
  if (ledgerPath !== undefined && (typeof ledgerPath !== "string" || ledgerPath.length === 0)) {
    throw new TypeError("server revision watcher: ledgerPath must be a non-empty path");
  }
  if (typeof resolveLedger !== "undefined" && typeof resolveLedger !== "function") {
    throw new TypeError("server revision watcher: resolveLedger must be a function");
  }
  if (ledgerPath === undefined && resolveLedger === undefined) {
    throw new TypeError("server revision watcher: ledgerPath or resolveLedger is required");
  }
  assertPositiveInteger(pollIntervalMs, "pollIntervalMs");
  if (typeof watchFactory !== "function") {
    throw new TypeError("server revision watcher: watchFactory must be a function");
  }
  if (typeof readFile !== "function") {
    throw new TypeError("server revision watcher: readFile must be a function");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("server revision watcher: onError must be a function");
  }

  const listeners = new Set();
  let currentRevision;
  let currentDirectory;
  let directoryWatcher;
  let interval;
  let wakeup;
  let pollPromise;
  let startPromise;
  let running = false;
  let closed = false;

  const reportError = (error) => {
    if (onError) onError(error);
  };

  const resolveLedgerPath = async () => {
    const resolved = resolveLedger ? await resolveLedger() : ledgerPath;
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new TypeError("server revision watcher: resolveLedger returned an invalid path");
    }
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
        if (closed) return;
        if (!wakeup) {
          wakeup = setTimeout(() => {
            wakeup = undefined;
            void poll().catch(reportError);
          }, 0);
          wakeup.unref?.();
        }
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
      const pathToLedger = await resolveLedgerPath();
      watchDirectory(path.dirname(pathToLedger));
      let raw;
      try {
        raw = await readFile(pathToLedger);
      } catch (error) {
        if (isMissing(error)) return currentRevision;
        throw error;
      }
      const revision = revisionFromLedger(raw, pathToLedger);
      if (currentRevision === undefined) {
        currentRevision = revision;
      } else if (emit && currentRevision !== revision) {
        currentRevision = revision;
        for (const listener of [...listeners]) {
          listener(revision);
        }
      } else {
        currentRevision = revision;
      }
      return currentRevision;
    })();
    try {
      return await pollPromise;
    } finally {
      pollPromise = undefined;
    }
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
      if (typeof listener !== "function") {
        throw new TypeError("server revision watcher: listener must be a function");
      }
      if (closed) throw new Error("server revision watcher: watcher is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
