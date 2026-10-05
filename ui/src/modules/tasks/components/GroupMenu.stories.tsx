import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { isSurfaceOpen, must } from "../../../test-utils/story";

import { GroupMenu } from "./GroupMenu";
import type { TaskGroupBy } from "../types";

/**
 * Menú de agrupar.
 *
 * Mismo comportamiento que `SortMenu` —de hecho comparten `usePopoverMenu` y `PopoverSurface`— con
 * dos diferencias: es más chico (180px contra 220px) y no tiene sección de dirección, porque agrupar
 * no tiene sentido inverso.
 *
 * Agrupar y filtrar son ejes independientes: elegir un grupo no toca los filtros.
 */
const meta = {
  title: "Tasks/GroupMenu",
  component: GroupMenu,
  parameters: { layout: "fullscreen" },
  argTypes: {
    group: { control: "inline-radio", options: ["status", "tags", "initiative", "none"] },
    onGroup: { control: false },
    isOpen: { control: false },
    onOpen: { control: false },
    onClose: { control: false },
  },
} satisfies Meta<typeof GroupMenu>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/** Ver el comentario de `openSort` en `SortMenu.stories.tsx`: es lo mismo con otro menú. */
const Host = (props: { group?: TaskGroupBy }) => {
  const [group, setGroup] = createSignal<TaskGroupBy>(props.group ?? "status");
  const [open, setOpen] = createSignal(false);
  return (
    <div class="flex justify-end bg-white p-4">
      <GroupMenu group={group()} onGroup={setGroup} isOpen={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} />
    </div>
  );
};

export const Playground: Story = {
  args: { group: "status" },
  render: () => <Host />,
};

/** Cerrado con el grupo por defecto (`status`): el trigger está en `text-muted`. */
export const Closed: Story = {
  render: () => <Host />,
};

/** Abre el menú con un click real y verifica que quedó abierto. */
const openGroup = async () => {
  await userEvent.click(must(document.querySelector("[data-group-trigger]"), "el trigger de Group"));
  await waitFor(() => expect(isSurfaceOpen("task-group-menu")).toBe(true));
};

/** Abierto: las 4 opciones, con el check en `Status`. */
export const Open: Story = {
  render: () => <Host />,
  play: openGroup,
};

/** Cerrado con un grupo no por defecto: el trigger se pinta en `text-ink`. */
export const AppliedGroup: Story = {
  render: () => <Host group="tags" />,
};

/** Abierto con `Labels` aplicado, para ver el check corrido y el trigger marcado. */
export const OpenWithAppliedGroup: Story = {
  render: () => <Host group="tags" />,
  play: openGroup,
};
