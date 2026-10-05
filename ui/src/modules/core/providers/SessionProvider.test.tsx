import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY } from "../http/protocol";
import type { StorageLike } from "../http/client";
import { SessionProvider, useSession, type SessionController } from "./SessionProvider";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function waitFor(condition: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SessionProvider");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function renderSession(storage: StorageLike, options: { probe?: boolean } = {}) {
  let session: SessionController | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => (
    <SessionProvider storage={storage} probe={options.probe}>
      <CaptureSession capture={(value) => { session = value; }} />
    </SessionProvider>
  ), host);
  return () => session!;
}

describe("SessionProvider", () => {
  it("unlocks the app when the server answers the catalog without a bearer", async () => {
    const storage = memoryStorage();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input), window.location.origin).pathname);
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const session = renderSession(storage);

    expect(session().authenticated()).toBe(false);
    await waitFor(() => session().authenticated());
    expect(paths).toContain("/v1/projects");
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("keeps the login gate when the server requires a bearer", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "token required" },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })));
    const session = renderSession(storage);

    await waitFor(() => session() !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session().authenticated()).toBe(false);
  });

  it("does not probe when the runtime is a fixture", async () => {
    const storage = memoryStorage();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const session = renderSession(storage, { probe: false });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session().authenticated()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a login bearer and removes it on logout", async () => {
    const storage = memoryStorage();
    let session: SessionController | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, token: "token-2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => (
      <SessionProvider storage={storage}>
        <CaptureSession capture={(value) => { session = value; }} />
      </SessionProvider>
    ), host);

    expect(session).toBeDefined();
    expect(await session!.login("password")).toBe(true);
    expect(session!.authenticated()).toBe(true);
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBe("token-2");

    session!.logout();
    expect(session!.authenticated()).toBe(false);
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

function CaptureSession(props: { capture: (session: SessionController) => void }) {
  props.capture(useSession());
  return null;
}
