import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { isSurfaceOpen, must } from "../../../test-utils/story";

import { SortMenu } from "./SortMenu";
import type { TaskSort } from "../types";

/**
 * Menú de orden: los 4 criterios y después la dirección.
 *
 * Dos reglas que se ven acá:
 *
 * 1. **Elegir un criterio impone la dirección.** `Title` y `Status` arrancan ascendente, el resto
 *    descendente. Conservar la dirección anterior daría resultados que nadie pidió —ordenar por
 *    título de la Z a la A no significa nada.
 * 2. **El trigger avisa cuando el orden no es el de por defecto.** Con `updated` desc queda en
 *    `text-muted`; con cualquier otro, en `text-ink`. Sin abrir el menú se sabe que hay algo aplicado.
 */
const meta = {
  title: "Tasks/SortMenu",
  component: SortMenu,
  parameters: { layout: "fullscreen" },
  argTypes: {
    sort: { control: "object" },
    onSort: { control: false },
    isOpen: { control: false },
    onOpen: { control: false },
    onClose: { control: false },
  },
} satisfies Meta<typeof SortMenu>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/**
 * Monta el menú con su propio estado.
 *
 * Para mostrarlo abierto hay que clickear el trigger: `usePopoverMenu` calcula la posición midiendo el
 * trigger, así que no se puede inyectar desde afuera. Eso lo hace el `play` de cada story abierta.
 */
const Host = (props: { sort?: TaskSort }) => {
  const [sort, setSort] = createSignal<TaskSort>(props.sort ?? { key: "updated", dir: "desc" });
  const [open, setOpen] = createSignal(false);
  return (
    <div class="flex justify-end bg-white p-4">
      <SortMenu sort={sort()} onSort={setSort} isOpen={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} />
    </div>
  );
};

/** Cerrado, con el orden por defecto (`updated` desc): el trigger está en `text-muted`. */
export const Closed: Story = {
  render: () => <Host />,
};

/**
 * Abre el menú con un click real y verifica que quedó abierto.
 *
 * Antes esto era un `onMount` que hacía `trigger.click()`: no era ni un test ni una interacción, era un
 * truco para que la story arrancara abierta. Con `play`, `userEvent` despacha la secuencia completa de
 * eventos de puntero y la story **falla** si el menú no abre.
 */
const openSort = async () => {
  await userEvent.click(must(document.querySelector("[data-sort-trigger]"), "el trigger de Sort"));
  await waitFor(() => expect(isSurfaceOpen("task-sort-menu")).toBe(true));
};

/** Abierto. El check verde marca el criterio activo y, abajo de la línea, la dirección. */
export const Open: Story = {
  render: () => <Host />,
  play: openSort,
};

/** Cerrado pero con un orden no por defecto: el trigger se pinta en `text-ink`. */
export const AppliedSort: Story = {
  render: () => <Host sort={{ key: "id", dir: "desc" }} />,
};

/** Abierto con un criterio aplicado, para ver el check en `Title` en vez de en `Last updated`. */
export const OpenWithAppliedSort: Story = {
  render: () => <Host sort={{ key: "title", dir: "asc" }} />,
  play: openSort,
};

/** Interactivo: hacer clic en el trigger abre, elegir un criterio aplica y cierra. */
export const Interactive: Story = {
  render: () => (
    <div class="bg-white p-4">
      <p class="mb-3 text-[12px] text-muted">Clic en Sort para abrir. Elegir un criterio cierra el menú y devuelve el foco al trigger.</p>
      <Host />
    </div>
  ),
};
