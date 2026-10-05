/**
 * Breakpoints de layout en forma de media query, para usar desde JS.
 *
 * **Deben coincidir con los `@media` de `src/styles/style.css`.** Es la única duplicación
 * inevitable entre CSS y JS: las media queries no se pueden leer como custom properties sin
 * evaluar `getComputedStyle` en runtime. Si se cambia uno, hay que cambiar el otro.
 */
export const BREAKPOINTS = {
  /** Sidebar colapsada a drawer. */
  compact: "(max-width: 1023px)",
  /** Vista de lista de tasks reemplazada por kanban. */
  narrow: "(max-width: 639px)",
  /** Registries use a detail overlay until the two-column layout has enough list width. */
  registryOverlay: "(max-width: 1279px)",
} as const;
