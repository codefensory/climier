import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { TasksPage } from "./TasksPage";

/**
 * Tasks: toolbar + board, con el estado del board real.
 *
 * Desde la Fase 8b ese estado es **la URL**: `useTasksUrl()` lee y escribe los search params, así que la
 * página no se puede montar sin router (tira al leer la location). Antes era `TasksBoardProvider`, que hacía
 * el mismo trabajo —sobrevivir al cambio de vista— con estado en memoria.
 *
 * Esto hace que la story sea más simple y más honesta a la vez: en vez de montar un provider y después
 * clickear para llegar a kanban, la story **arranca en la URL de kanban**, que es exactamente lo que hace
 * un link compartido.
 */
const meta = {
  title: "Pages/TasksPage",
  component: TasksPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TasksPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/** Monta la página en `/tasks`. El `path` del `StoryShell` es la URL con la que arranca. */
const Host = (props: { path?: string }) => (
  <StoryShell path={props.path ?? "/tasks"}>
    <div class="bg-white">
      <TasksPage />
    </div>
  </StoryShell>
);

export const Playground: Story = {
  render: () => <Host />,
};

/**
 * Kanban por URL, sin clickear nada.
 *
 * Es el caso que la Fase 8b hace posible: antes, llegar a kanban requería interactuar (el provider no
 * aceptaba un valor inicial y agregarle uno habría sido API sólo para las stories). Ahora es un estado que
 * se puede escribir en la barra de direcciones, y la story lo verifica de las dos maneras: el switch dice
 * Kanban y el board **es** kanban.
 */
export const Kanban: Story = {
  render: () => <Host path="/tasks?view=kanban" />,
  play: async () => {
    const segments = [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view-switch"] button')];
    const kanban = must(segments.find((button) => button.textContent?.trim() === "Kanban") ?? null, "el segmento Kanban");
    await waitFor(() => expect(kanban.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
  },
};

/**
 * Cambia a kanban con un click real y verifica las dos mitades: el switch y la URL.
 *
 * La story de arriba prueba el estado; esta prueba el camino. Y agrega la aserción que valida la premisa de
 * la fase: que el click **escriba la URL** — si el board cambia pero la URL no, el estado no se puede
 * compartir, que es la mitad del punto.
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
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?view=kanban"));
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
