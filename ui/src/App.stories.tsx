import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import App from "./App";
import { must, sidebarItem } from "./test-utils/story";
import { resetStoryUrl } from "./test-utils/StoryShell";

/**
 * Story de humo de la Fase 0.
 *
 * No tiene props ni args: el objetivo no es documentar `App` sino verificar que el wiring
 * de Storybook funciona de punta a punta contra la app real:
 *
 *  - Tailwind v4 genera utilidades (el sidebar debe medir 248px, la grilla de puntos visible).
 *  - El `@theme` de `style.css` aplica (tipografía DM Sans / Manrope / Inter).
 *  - Los iconos de Hugeicons renderizan con su stroke correcto.
 *  - Las fuentes de Google cargan (requiere red; ver nota de self-hosting en el plan).
 *  - Sin errores en consola por el Portal de los menús.
 *
 * Los tres viewports corresponden a los breakpoints reales de `src/style.css`.
 */

/**
 * Limpia la URL antes de montar la app.
 *
 * `App` arma su propio router y lee la URL del iframe, y la URL **sobrevive entre stories** porque el
 * corredor reusa la página: sin esto, la story que corre después de `Tasks Flow` (que navega) arrancaría en
 * `/tasks` creyendo arrancar en Home. Es la misma clase de fuga que los `globals.viewport` documentados en
 * la Fase 7, y la misma solución: que cada story deje el estado externo en un punto conocido.
 *
 * Va en `loaders` y no en un decorador porque los loaders corren **antes** de que el árbol se construya,
 * que es exactamente lo que hace falta: un decorador tendría que acordarse de leer `props.children`
 * después de limpiar, y el orden entre el decorador del meta y el de una story no es evidente. Además un
 * loader se puede pisar desde una story (ver `DeepLink`), que es como se prueba un link profundo.
 */
const cleanUrl = async () => {
  resetStoryUrl("/");
  return {};
};

const meta = {
  component: App,
  loaders: [cleanUrl],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = {};

export const Compact: Story = {
  globals: { viewport: { value: "compact" } },
};

export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
};

/**
 * Interacción real: entrar a Tasks desde el sidebar.
 *
 * Antes de la Fase 7 este camino se verificaba a mano en el navegador, con scripts que clickeaban el
 * sidebar y comparaban el DOM. Ahora es un test: si el board no se monta, falla.
 */
export const TasksFlow: Story = {
  // El viewport se declara acá y no se hereda: en el corredor de tests (Fase 7) los `globals` de una
  // story **persisten** a las siguientes del mismo archivo, así que esta story, que viene después de
  // `Narrow`, corría a 639px y el board salía en kanban. Medido: sin esta línea el test falla con
  // timeout esperando `tasks-list-view`; con ella corre a 1440 y la aserción es determinista.
  globals: { viewport: { value: "wide" } },
  play: async () => {
    await userEvent.click(sidebarItem("Tasks"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-toolbar"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-list-view"]')).not.toBeNull());
    // La vista activa vive en la URL: si el click navega pero la URL no cambia, el estado se puede ver
    // pero no compartir, que es la mitad del punto de la Fase 8.
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
  },
};

/**
 * Interacción real: entrar a Settings desde el sidebar.
 *
 * Comprueba las **dos mitades** del cambio de vista: el panel de settings queda visible y la vista de
 * atrás queda `aria-hidden` + `inert`, que es lo que la saca del orden de tabulación. Mirar sólo lo
 * primero daría por bueno un panel que aparece encima de contenido que sigue siendo alcanzable.
 */
export const SettingsFlow: Story = {
  play: async () => {
    // Esta story corre justo después de `TasksFlow`, que navega a `#/tasks`. Arrancar en `#/` es lo que
    // prueba que el reset del meta corrió de verdad: sin él, el hash de la story anterior se hereda.
    await expect(window.location.hash).toBe("#/");

    await userEvent.click(sidebarItem("Tasks"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));

    await userEvent.click(sidebarItem("Settings"));
    await waitFor(() => expect(document.querySelector('[data-testid="settings-content"]')?.getAttribute("aria-hidden")).toBe("false"));
    const workspace = must(document.querySelector('[data-testid="main-content"]'), "la vista de atrás");
    await expect(workspace.getAttribute("aria-hidden")).toBe("true");
    await expect(workspace.hasAttribute("inert")).toBe(true);

    // El panel va como search param sobre la vista actual, no como ruta propia: por eso el path sigue
    // siendo `/tasks` y la vista de atrás no se pierde. Con una ruta `/settings`, acá el path habría
    // cambiado y el botón de volver llevaría a Home en vez de a Tasks.
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?panel=settings"));
  },
};

/**
 * Link profundo: la URL reproduce el estado sin haber clickeado nada.
 *
 * Es la razón de ser de la fase, y por eso se prueba con la URL puesta **antes** de montar (loader) en vez de
 * navegando. Verifica las dos mitades del estado: el panel abierto y la vista de atrás montada, que es
 * justamente lo que una ruta propia (`/settings`) no podría reproducir.
 */
export const DeepLink: Story = {
  globals: { viewport: { value: "wide" } },
  loaders: [
    async () => {
      resetStoryUrl("/tasks?panel=settings");
      return {};
    },
  ],
  play: async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="settings-content"]')?.getAttribute("aria-hidden")).toBe("false"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-toolbar"]')).not.toBeNull());
    const workspace = must(document.querySelector('[data-testid="main-content"]'), "la vista de atrás");
    await expect(workspace.getAttribute("aria-hidden")).toBe("true");
  },
};
