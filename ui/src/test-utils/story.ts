/**
 * Helpers para las funciones `play` de las stories.
 *
 * Vive en `src/` pero **no** es parte de la app: no lo importa nada de `src/App.tsx` ni de los módulos, así
 * que Vite no lo mete en el bundle. `tsconfig.app.json` lo excluye y `tsconfig.storybook.json` lo incluye,
 * igual que a las stories.
 *
 * Existe porque las `play` necesitan dos cosas que se repiten en cada archivo: encontrar un elemento y
 * fallar con un mensaje que diga **cuál** faltó. Un `!` de TypeScript sobre `querySelector` daría un
 * "Cannot read properties of null" sin decir qué selector buscaba.
 *
 * ### Por qué las aserciones posteriores a un click van dentro de `waitFor`
 *
 * Porque `userEvent` usa los eventos de entrada reales del navegador (vía CDP), y el handler corre en
 * una tarea del renderer que puede ejecutarse **después** de que la promesa del click se resuelve. La
 * primera versión de estas `play` falló por eso: el click funcionaba, pero la aserción miraba el DOM
 * antes de que Solid aplicara el cambio. Es una carrera del instrumento, no del código.
 */

/** Devuelve el elemento o tira un error que nombra lo que se buscaba. */
export function must<T extends Element>(element: T | null, what: string): T {
  if (!element) throw new Error(`No encontré ${what}.`);
  return element;
}

/**
 * Una superficie flotante por su `id`.
 *
 * Los menús y el panel van a un `Portal`, o sea fuera del `#storybook-root`, así que hay que buscarlos en
 * el documento y no en el `canvasElement` de la story.
 */
export function surface(id: string): HTMLElement {
  return must(document.getElementById(id), `la superficie #${id}`);
}

/**
 * El estado abierto/cerrado que `PopoverSurface` publica en `data-open`.
 *
 * No tira si la superficie no existe: se usa adentro de un `waitFor`, y ahí un throw abortaría el
 * reintento en vez de reintentarlo.
 */
export function isSurfaceOpen(id: string): boolean {
  return document.getElementById(id)?.getAttribute("data-open") === "true";
}

/** Un item del sidebar por su etiqueta visible. */
export function sidebarItem(label: string): HTMLElement {
  const items = [...document.querySelectorAll<HTMLElement>('[data-testid="app-sidebar"] button')];
  return must(
    items.find((item) => item.textContent?.trim() === label) ?? null,
    `el item "${label}" del sidebar`,
  );
}
