import type { StorageLike } from "../http/client";

export const THEME_STORAGE_KEY = "climier-ui:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const META_THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f6f6f6",
  dark: "#0e0e11",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type StoredPreference = {
  preference: ThemePreference;
  hasValue: boolean;
  failed: boolean;
};

function readStoragePreference(storage: StorageLike | null | undefined): StoredPreference {
  const source = storage === undefined ? getBrowserStorage() : storage;
  if (!source) return { preference: "system", hasValue: false, failed: false };
  try {
    const value = source.getItem(THEME_STORAGE_KEY);
    return {
      preference: isThemePreference(value) ? value : "system",
      hasValue: value !== null,
      failed: false,
    };
  } catch {
    return { preference: "system", hasValue: false, failed: true };
  }
}

export function readStoredPreference(storage?: StorageLike | null): ThemePreference {
  return readStoragePreference(storage).preference;
}

export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
}

export function initialThemePreference(storage?: StorageLike | null, existingTheme?: string): ThemePreference {
  const stored = readStoragePreference(storage);
  if (stored.hasValue || stored.failed) return stored.preference;
  return existingTheme === "light" || existingTheme === "dark" ? existingTheme : "system";
}
