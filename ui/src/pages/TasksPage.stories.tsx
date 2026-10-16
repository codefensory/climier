import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { TASKS_VIEW_STORAGE_KEY, type TaskView } from "../modules/tasks";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { TasksPage } from "./TasksPage";

/**
 * Tasks: toolbar + board, con el estado del board real.
 *
 * Ese estado tiene dos casas. Alcance, orden, agrupación y filtros son **la URL** (una consulta que se
 * comparte y se recarga, `useTasksUrl()`), así que la página no se puede montar sin router. La **vista**
 * es una preferencia del navegador, en `localStorage`: cambiarla no navega, así que el botón de atrás no
 * la pisa. Por eso las stories que arrancan en kanban siembran el storage en vez de escribir un
 * search param, y la que prueba el camino verifica que la URL **no** cambie.
 */
const meta = {
  title: "Pages/TasksPage",
  component: TasksPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TasksPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/** Monta la página en `/tasks`. El `storage` del `StoryShell` es la preferencia con la que arranca. */
const Host = (props: { path?: string; view?: TaskView }) => (
  <StoryShell path={props.path ?? "/tasks"} storage={props.view ? { [TASKS_VIEW_STORAGE_KEY]: props.view } : undefined}>
    <div class="bg-surface">
      <TasksPage />
    </div>
  </StoryShell>
);

export const Playground: Story = {
  render: () => <Host />,
};

export const DarkList: Story = {
  globals: { theme: "dark", viewport: { value: "wide" } },
  render: () => <Host />,
};

export const DarkKanban: Story = {
  globals: { theme: "dark", viewport: { value: "wide" } },
  render: () => <Host view="kanban" />,
  play: async () => {
    const segments = [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view-switch"] button')];
    const kanban = must(segments.find((button) => button.textContent?.trim() === "Kanban") ?? null, "el segmento Kanban");
    await waitFor(() => expect(kanban.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
  },
};

/**
 * Kanban guardado, sin clickear nada.
 *
 * Es el estado que sobrevive a recargar y a irse a otra vista: el usuario ya eligió kanban, así que la
 * página tiene que abrir en kanban aunque la URL sea `#/tasks` a secas. Se verifica de las dos maneras: el
 * switch dice Kanban y el board **es** kanban.
 */
export const Kanban: Story = {
  render: () => <Host view="kanban" />,
  play: async () => {
    const segments = [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view-switch"] button')];
    const kanban = must(segments.find((button) => button.textContent?.trim() === "Kanban") ?? null, "el segmento Kanban");
    await waitFor(() => expect(kanban.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
  },
};

/**
 * Cambia a kanban con un click real y verifica las dos mitades: el board cambia y la **URL no**.
 *
 * Es el contrato que reemplaza al de la Fase 8b: antes el click escribía `?view=kanban` y ahora escribe la
 * preferencia del navegador. Las dos aserciones importan —si el board cambia pero la URL cambia también,
 * el atrás vuelve a decidir la vista; si la URL no cambia pero el storage no se escribe, la elección se
 * pierde al recargar—.
 */
export const KanbanFlow: Story = {
  render: () => <Host />,
  play: async () => {
    await expect(window.location.hash).toBe("#/tasks");
    const segments = [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view-switch"] button')];
    const kanban = must(segments.find((button) => button.textContent?.trim() === "Kanban") ?? null, "el segmento Kanban");
    await userEvent.click(kanban);
    await waitFor(() => expect(kanban.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
    await waitFor(() => expect(window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)).toBe("kanban"));
    await expect(window.location.hash).toBe("#/tasks");
  },
};

/**
 * Un árbol de filtros que llega por la URL.
 *
 * El param está escrito **a mano** y no generado con `encodeFilterTree()` a propósito: si la story usara el
 * codificador, un cambio de formato pasaría el test sin que nadie se entere. Así, el formato es parte del
 * contrato y cambiarlo obliga a actualizar la story.
 *
 * Es lo que antes hacía `initialTree` en `useTaskFilters` (una vía para que una story muestre un panel con
 * condiciones sin simular clicks), pero por el camino real: la URL.
 */
export const FilteredByUrl: Story = {
  render: () => <Host path={`/tasks?filter=${encodeURIComponent('{"c":[{"f":"status","o":"is","v":["blocked"]}],"g":[]}')}`} />,
  play: async () => {
    // El contador del badge sale del árbol, así que verifica que llegó entero.
    await waitFor(() => expect(document.querySelector('[aria-label="Filter"]')?.textContent?.trim()).toBe("Filter1"));

    // Y el panel tiene que mostrar la condición que vino en la URL, campo, operador y valor incluidos.
    await userEvent.click(must(document.querySelector('[aria-label="Filter"]') as HTMLElement | null, "el trigger de filtros"));
    await waitFor(() => expect(document.querySelectorAll('[data-testid="filter-condition"]').length).toBe(1));
    const row = must(document.querySelector('[data-testid="filter-condition"]'), "la fila de condición");
    await expect(row.textContent).toContain("Status");
    await expect(row.textContent).toContain("is");
    await expect(row.textContent).toContain("Blocked");
  },
};

/**
 * Angosto (≤639px).
 *
 * `TaskBoardContainer` lee `useMediaQuery(BREAKPOINTS.narrow)` por su cuenta y muestra kanban **aunque el
 * switch diga List**. Es una adaptación, no una preferencia: la lista necesita ancho para los metadatos.
 */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => <Host />,
};

/**
 * Abrir una tarea desde el board.
 *
 * Verifica las dos mitades: que el click sobre la fila navegue y que la URL quede en el detalle. La
 * fila es accionable porque la página le pasa `onOpenTask`; sin ese cableado, el click no haría nada
 * y la vista de detalle existiría sin forma de llegar.
 */
export const OpensTaskDetail: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host />,
  play: async () => {
    const row = must(document.querySelector<HTMLElement>('[data-testid="task-row"]'), "la primera fila de tarea");
    await userEvent.click(row);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/tasks\/.+$/));
  },
};
