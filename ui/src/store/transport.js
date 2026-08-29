// Pure polling transport for the climier UI store.
//
// Encapsulates:
//   - the `getSnapshot` / `getNode` fetchers from ../api.js
//   - a 2-second polling loop with AbortController cancellation
//   - monotonic tokens that discard late responses
//   - load / error / refreshing / initial-loading / lastSuccessfulAt
//     state transitions emitted via plain callbacks
//   - cleanup (interval, in-flight aborts, visibilitychange listener)
//
// This module does NOT import JSX or `solid-js`; the facade layer wires
// these callbacks to reactive signals. The transport stays a plain ES
// module so it can be inspected or unit-tested independently of the view
// model. It does not export `useStore` or any Solid primitive.
//
// Behavior (matches the polling block previously embedded in
// `ui/src/store.jsx`):
//   - Polls every POLL_MS (2000 ms) and refreshes the open detail if any.
//   - On `document.visibilitychange` to "visible" the polling tick fires
//     immediately so a tab that was hidden catches up without waiting for
//     the next interval.
//   - Each request aborts the previous one and bumps a monotonic token;
//     responses whose token has already been bumped past are dropped
//     silently, even if the underlying AbortSignal failed to fire.
//   - On a snapshot fetch error the previous snapshot is preserved: we
//     surface the error via `onSnapshotError` instead of clobbering the
//     consumer's last good snapshot.
//   - On `stop()` the interval, the visibility listener, and every
//     in-flight request are torn down; tokens are bumped so any late
//     response that already slipped past the abort is discarded.

import { getSnapshot, getNode } from "../api.js";

export const POLL_MS = 2000;

function noop() {}

function messageOf(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  return String(err);
}

// `fetch` rejects with a DOMException whose `name === "AbortError"` when
// the AbortSignal fires. Some engines also expose `code === 20`
// (DOMException.ABORT_ERR). Treat both as expected cancellation so the
// polling loop does not surface them as snapshot errors.
function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  if (err.code === 20) return true;
  return false;
}

// Monotonic counter used to discard late responses. Each new request gets
// a fresh token; older responses whose counter has been bumped past are
// dropped silently. Combined with AbortController (which cancels the
// in-flight fetch) this prevents a slow earlier request from clobbering
// a newer one when the user is clicking around faster than the network.
function createTokenSource() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    peek() {
      return current;
    },
    bump() {
      current += 1;
      return current;
    },
  };
}

/**
 * Create a polling transport controller.
 *
 * Options (all optional; defaults to no-op callbacks and global timers):
 *   - onSnapshot(snap)               successful snapshot fetch
 *   - onSnapshotError(message|null)  snapshot fetch failure; null clears it
 *   - onLastSuccessfulAt(iso)        ISO timestamp after each success
 *   - onInitialLoading(boolean)      true until the first good snapshot
 *   - onRefreshing(boolean)          true while a poll is in flight
 *   - onDetail(node)                 successful detail fetch
 *   - onDetailError(message|null)    detail fetch failure; null clears it
 *   - onDetailClear()                selection cleared; drop cached detail
 *   - clock                          injectable { setInterval, clearInterval }
 *   - visibilityTarget               EventTarget for visibilitychange
 *                                    (defaults to global `document` if any)
 *   - visibilityEvent                event name (default "visibilitychange")
 *
 * Returns a controller with:
 *   - start()      begin polling (idempotent)
 *   - stop()       cancel polling + in-flight requests (idempotent)
 *   - reload()     force an immediate snapshot fetch (no-op if stopped)
 *   - select(id)   fetch detail for id (or clear when id is null/empty)
 *   - isRunning()  true between start() and stop()
 *   - POLL_MS      exported poll interval, exposed for callers / tests
 */
export function createTransport(opts = {}) {
  const onSnapshot = opts.onSnapshot || noop;
  const onSnapshotError = opts.onSnapshotError || noop;
  const onLastSuccessfulAt = opts.onLastSuccessfulAt || noop;
  const onInitialLoading = opts.onInitialLoading || noop;
  const onRefreshing = opts.onRefreshing || noop;
  const onDetail = opts.onDetail || noop;
  const onDetailError = opts.onDetailError || noop;
  const onDetailClear = opts.onDetailClear || noop;

  const clock = opts.clock || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
  const visibilityTarget =
    opts.visibilityTarget !== undefined
      ? opts.visibilityTarget
      : typeof document !== "undefined"
      ? document
      : null;
  const visibilityEvent = opts.visibilityEvent || "visibilitychange";

  const pollTokens = createTokenSource();
  const detailTokens = createTokenSource();

  let pollAbort = null;
  let detailAbort = null;
  let interval = null;
  let visibilityHandler = null;
  let running = false;
  let hasGoodSnapshot = false;
  let currentDetailId = null;

  async function loadSnapshot() {
    const token = pollTokens.next();
    if (pollAbort) pollAbort.abort();
    const controller = new AbortController();
    pollAbort = controller;
    if (!hasGoodSnapshot) onInitialLoading(true);
    onRefreshing(true);
    try {
      const snap = await getSnapshot({ signal: controller.signal });
      if (token < pollTokens.peek()) return; // a newer poll already won
      hasGoodSnapshot = true;
      onSnapshot(snap);
      onSnapshotError(null);
      onLastSuccessfulAt(new Date().toISOString());
    } catch (e) {
      if (isAbortError(e)) return;
      if (token < pollTokens.peek()) return;
      // Keep the previous snapshot; just surface the error so the view
      // can render a banner.
      onSnapshotError(messageOf(e));
    } finally {
      if (token === pollTokens.peek()) {
        onRefreshing(false);
        onInitialLoading(false);
      }
    }
  }

  async function loadDetail(id) {
    if (!id) {
      onDetailClear();
      return;
    }
    const token = detailTokens.next();
    if (detailAbort) detailAbort.abort();
    const controller = new AbortController();
    detailAbort = controller;
    try {
      const node = await getNode(id, { signal: controller.signal });
      if (token < detailTokens.peek()) return; // a newer request already won
      onDetail(node);
      onDetailError(null);
    } catch (e) {
      if (isAbortError(e)) return;
      if (token < detailTokens.peek()) return;
      onDetailError(messageOf(e));
    }
  }

  function tick() {
    loadSnapshot();
    if (currentDetailId) loadDetail(currentDetailId);
  }

  function start() {
    if (running) return;
    running = true;
    loadSnapshot();
    interval = clock.setInterval(tick, POLL_MS);
    if (
      visibilityTarget &&
      typeof visibilityTarget.addEventListener === "function"
    ) {
      visibilityHandler = () => {
        if (visibilityTarget.visibilityState === "visible") tick();
      };
      visibilityTarget.addEventListener(visibilityEvent, visibilityHandler);
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    // Bump tokens first so any response that slipped past abort() is
    // discarded by the token check in loadSnapshot / loadDetail.
    pollTokens.bump();
    detailTokens.bump();
    if (interval != null) {
      clock.clearInterval(interval);
      interval = null;
    }
    if (pollAbort) {
      pollAbort.abort();
      pollAbort = null;
    }
    if (detailAbort) {
      detailAbort.abort();
      detailAbort = null;
    }
    if (
      visibilityTarget &&
      visibilityHandler &&
      typeof visibilityTarget.removeEventListener === "function"
    ) {
      visibilityTarget.removeEventListener(visibilityEvent, visibilityHandler);
      visibilityHandler = null;
    }
  }

  function reload() {
    if (!running) return;
    loadSnapshot();
  }

  function select(id) {
    currentDetailId = id || null;
    if (!currentDetailId) {
      if (detailAbort) {
        detailAbort.abort();
        detailAbort = null;
      }
      detailTokens.bump();
      onDetailClear();
      return;
    }
    if (!running) return;
    loadDetail(currentDetailId);
  }

  return {
    start,
    stop,
    reload,
    select,
    isRunning: () => running,
    POLL_MS,
  };
}