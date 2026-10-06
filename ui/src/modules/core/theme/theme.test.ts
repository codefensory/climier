import { describe, expect, it } from "vitest";
import {
  META_THEME_COLOR,
  readStoredPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

function storage(value: string | null) {
  return {
    getItem: (key: string) => key === THEME_STORAGE_KEY ? value : null,
    setItem: () => {},
    removeItem: () => {},
  };
}

describe("theme runtime", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] satisfies [ThemePreference, boolean, "light" | "dark"][]) (
    "resolves %s with system dark=%s to %s",
    (preference, systemPrefersDark, expected) => {
      expect(resolveTheme(preference, systemPrefersDark)).toBe(expected);
    },
  );

  it("falls back to the system for an invalid stored value", () => {
    expect(readStoredPreference(storage("sepia"))).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("falls back to system when storage throws", () => {
    const brokenStorage = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => {},
      removeItem: () => {},
    };

    expect(readStoredPreference(brokenStorage)).toBe("system");
  });

  it("defines the canvas colors used by the document meta tag", () => {
    expect(META_THEME_COLOR).toEqual({ light: "#f6f6f6", dark: "#0e0e11" });
  });
});
