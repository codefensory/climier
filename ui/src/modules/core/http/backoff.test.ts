import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff";

describe("SSE reconnect backoff", () => {
  it("grows exponentially, applies jitter, and caps the delay", () => {
    expect(backoffDelay(0, { baseMs: 500, jitter: 0, random: () => 0 })).toBe(500);
    expect(backoffDelay(2, { baseMs: 500, jitter: 0, random: () => 0 })).toBe(2_000);
    expect(backoffDelay(3, { baseMs: 500, maxMs: 2_000, jitter: 0, random: () => 0 })).toBe(2_000);
    expect(backoffDelay(0, { baseMs: 500, jitter: 0.2, random: () => 0 })).toBe(400);
    expect(backoffDelay(0, { baseMs: 500, jitter: 0.2, random: () => 1 })).toBe(600);
  });
});
