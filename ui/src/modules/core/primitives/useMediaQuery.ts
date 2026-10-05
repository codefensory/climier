import { createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * Signal que sigue el estado de una media query.
 *
 * Síncrono en la lectura inicial (usa `mql.matches`, no `false`) para no parpadear al montar.
 * Si `matchMedia` no existe, devuelve `false` de forma estable.
 *
 * @param query Media query, normalmente una de `BREAKPOINTS`.
 */
export function useMediaQuery(query: string): Accessor<boolean> {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => false;

  const mql = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mql.matches);

  const sync = () => setMatches(mql.matches);
  mql.addEventListener("change", sync);
  onCleanup(() => mql.removeEventListener("change", sync));

  return matches;
}
