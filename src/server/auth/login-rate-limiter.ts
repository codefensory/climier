import net from "node:net";
import type { Headers, ServerError } from "../types.ts";

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_MS = 15 * 60 * 1000;

function normalizedAddress(address) {
  if (typeof address !== "string") {
    return null;
  }
  const trimmed = address.trim();
  if (!trimmed || !net.isIP(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("::ffff:") && net.isIPv4(trimmed.slice(7))) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function isLoopbackAddress(address) {
  const normalized = normalizedAddress(address);
  if (!normalized) {
    return false;
  }
  if (net.isIPv4(normalized)) {
    return normalized.split(".")[0] === "127";
  }
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function forwardedAddress(header) {
  if (Array.isArray(header)) {
    return null;
  }
  if (typeof header !== "string") {
    return null;
  }
  const parts = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }
  return normalizedAddress(parts[0]);
}

type LoginRequest = { socket?: { remoteAddress?: unknown }; headers?: Headers };

type RateLimiterOptions = {
  now?: () => number;
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
};

export function loginClientAddress(request: LoginRequest) {
  const peer = normalizedAddress(request?.socket?.remoteAddress) || "unknown";
  if (!isLoopbackAddress(peer)) {
    return peer;
  }
  return forwardedAddress(request.headers?.["x-forwarded-for"]) || peer;
}

function rateLimitedError(retryAfterMs) {
  const error = new Error("server http: login rate limit exceeded") as ServerError;
  error.code = "AUTH_RATE_LIMITED";
  error.status = 429;
  error.details = { retry_after_ms: Math.max(0, retryAfterMs) };
  return error;
}

export function createLoginRateLimiter({
  now = Date.now,
  maxFailures = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
  lockMs = DEFAULT_LOCK_MS,
}: RateLimiterOptions = {}) {
  const entries = new Map();
  const currentTime = () => Number(now());

  function entryFor(key, time) {
    const entry = entries.get(key);
    if (!entry || entry.windowStartedAt + windowMs <= time) {
      const next = { failures: 0, windowStartedAt: time, lockedUntil: 0 };
      entries.set(key, next);
      return next;
    }
    return entry;
  }

  return Object.freeze({
    assertAllowed(key) {
      const time = currentTime();
      const entry = entries.get(key);
      if (entry?.lockedUntil > time) {
        throw rateLimitedError(entry.lockedUntil - time);
      }
    },
    recordFailure(key) {
      const time = currentTime();
      const entry = entryFor(key, time);
      entry.failures += 1;
      if (entry.failures >= maxFailures) {
        entry.lockedUntil = time + lockMs;
      }
    },
    recordSuccess(key) {
      entries.delete(key);
    },
  });
}
