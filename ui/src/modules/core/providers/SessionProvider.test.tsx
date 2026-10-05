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

describe("SessionProvider", () => {
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
