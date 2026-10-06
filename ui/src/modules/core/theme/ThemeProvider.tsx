import { createContext, createEffect, createSignal, useContext, type Accessor, type JSX } from "solid-js";
import { useMediaQuery } from "../primitives/useMediaQuery";
import type { StorageLike } from "../http/client";
import {
  applyTheme,
  initialThemePreference,
  META_THEME_COLOR,
  isThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

export type ThemeController = {
  preference: Accessor<ThemePreference>;
  resolved: Accessor<ResolvedTheme>;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeController>();
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

function getStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function syncThemeColor(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = META_THEME_COLOR[resolved];
}

export function ThemeProvider(props: { children: JSX.Element; storage?: StorageLike | null }) {
  const storage = props.storage === undefined ? getStorage() : props.storage;
  const root = typeof document === "undefined" ? null : document.documentElement;
  const initialPreference = initialThemePreference(storage, root?.dataset.theme);
  const systemPrefersDark = useMediaQuery(SYSTEM_THEME_QUERY);
  const [preference, setPreferenceSignal] = createSignal<ThemePreference>(initialPreference);
  const resolved = () => resolveTheme(preference(), systemPrefersDark());

  const applyCurrentTheme = (value: ResolvedTheme) => {
    if (root) applyTheme(root, value);
    syncThemeColor(value);
  };

  createEffect(() => {
    applyCurrentTheme(resolved());
  });

  const setPreference = (requestedPreference: ThemePreference) => {
    const nextPreference = isThemePreference(requestedPreference) ? requestedPreference : "system";
    try {
      storage?.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // A blocked storage must not prevent changing the theme for this session.
    }
    setPreferenceSignal(nextPreference);
    applyCurrentTheme(resolveTheme(nextPreference, systemPrefersDark()));
  };

  const controller: ThemeController = { preference, resolved, setPreference };
  return <ThemeContext.Provider value={controller}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeController {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme() must be used inside <ThemeProvider>");
  return theme;
}
