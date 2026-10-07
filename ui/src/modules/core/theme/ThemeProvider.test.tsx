import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageLike } from "../http/client";
import { THEME_STORAGE_KEY } from "./theme";
import { ThemeProvider, useTheme, type ThemeController } from "./ThemeProvider";

function memoryStorage(initial: string | null = null): StorageLike {
  let value = initial;
  return {
    getItem: (key) => key === THEME_STORAGE_KEY ? value : null,
    setItem: (key, next) => { if (key === THEME_STORAGE_KEY) value = next; },
    removeItem: (key) => { if (key === THEME_STORAGE_KEY) value = null; },
  };
}

function mediaQuery(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return matches; },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as () => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as () => void);
    },
  } as unknown as MediaQueryList;
  return {
    media,
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  delete document.documentElement.dataset.theme;
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  vi.unstubAllGlobals();
});

function renderTheme(storage: StorageLike | null, capture: (theme: ThemeController) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => (
    <ThemeProvider storage={storage}>
      <CaptureTheme capture={capture} />
    </ThemeProvider>
  ), host);
}

describe("ThemeProvider", () => {
  it("adopts a pre-existing data-theme when storage has no preference", () => {
    document.documentElement.dataset.theme = "dark";
    const media = mediaQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media.media));
    let theme: ThemeController | undefined;

    renderTheme(memoryStorage(), (value) => { theme = value; });

    expect(theme?.preference()).toBe("dark");
    expect(theme?.resolved()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists and applies an explicit preference", () => {
    const storage = memoryStorage();
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    const media = mediaQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media.media));
    let theme: ThemeController | undefined;

    renderTheme(storage, (value) => { theme = value; });
    theme?.setPreference("dark");

    expect(theme?.preference()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(meta.content).toBe("#0e0e11");
  });

  it("keeps working when storage throws", () => {
    const brokenStorage: StorageLike = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage unavailable"); },
      removeItem: () => {},
    };
    const media = mediaQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media.media));
    let theme: ThemeController | undefined;

    renderTheme(brokenStorage, (value) => { theme = value; });
    theme?.setPreference("dark");

    expect(theme?.preference()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("tracks system changes while preference is system", async () => {
    const media = mediaQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media.media));
    let theme: ThemeController | undefined;

    renderTheme(memoryStorage("system"), (value) => { theme = value; });
    expect(theme?.resolved()).toBe("light");

    media.set(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(theme?.resolved()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

function CaptureTheme(props: { capture: (theme: ThemeController) => void }) {
  props.capture(useTheme());
  return null;
}
