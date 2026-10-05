import { describe, expect, it, vi } from "vitest";
import { createHttpClient, type FetchLike, type StorageLike } from "./client";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("core HTTP client", () => {
  it("adds protocol and bearer headers, and keeps ETag 304 responses empty", async () => {
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const responses = [
      jsonResponse({ ok: true, token: "token-1" }),
      jsonResponse({ projects: [] }),
      jsonResponse({ ok: true, result: { project: { id: "alpha", revision: 4 }, nodes: {} } }, 200, { etag: '"4"' }),
      new Response(null, { status: 304, headers: { etag: '"4"' } }),
      new Response(": heartbeat\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    ];
    const fetcher: FetchLike = async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("test response queue exhausted");
      return response;
    };
    const client = createHttpClient({ baseUrl: "https://climier.test/", fetch: fetcher, storage: memoryStorage() });

    await client.login("password");
    await client.getProjects();
    const first = await client.getSnapshot("alpha");
    const second = await client.getSnapshot("alpha", first.etag);
    await client.openEvents("alpha");

    expect(calls).toHaveLength(5);
    const loginHeaders = new Headers(calls[0].init?.headers);
    expect(loginHeaders.get("X-Climier-Protocol-Version")).toBe("1");
    expect(loginHeaders.get("Authorization")).toBeNull();
    const authenticatedHeaders = new Headers(calls[1].init?.headers);
    expect(authenticatedHeaders.get("Authorization")).toBe("Bearer token-1");
    expect(new Headers(calls[3].init?.headers).get("If-None-Match")).toBe('"4"');
    expect(new Headers(calls[4].init?.headers).get("Accept")).toBe("text/event-stream");
    expect(first).toEqual({ status: 200, snapshot: { project: { id: "alpha", revision: 4 }, nodes: {} }, etag: '"4"' });
    expect(second).toEqual({ status: 304, snapshot: null, etag: '"4"' });
  });

  it("clears authorization through the unauthorized callback", async () => {
    const onUnauthorized = vi.fn();
    const client = createHttpClient({
      baseUrl: "https://climier.test/",
      fetch: async () => jsonResponse({ error: { code: "AUTH_INVALID", message: "expired" } }, 401),
      storage: memoryStorage(),
      onUnauthorized,
    });

    await expect(client.getProjects()).rejects.toMatchObject({ status: 401, code: "AUTH_INVALID" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
