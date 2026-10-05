import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, waitFor } from "storybook/test";
import { makeTask } from "../data/fixtures";
import { gates, tasks } from "../data/tasks";
import { TaskListView } from "./TaskListView";
import type { TaskListViewProps } from "./TaskListView";

/**
 * Vista de lista completa: agrupa, ordena y compone las filas, con las gates abiertas en una sección
 * aparte arriba.
 *
 * Recibe las tareas por prop, así que las stories pueden pasar un conjunto vacío o uno extremo sin
 * tocar el fixture. El orden de los grupos no depende del criterio de orden: `status` sigue el flujo
 * de trabajo (`statusOrder`) y `tags` va alfabético; el sort cambia el orden **dentro** de cada grupo.
 */
const meta = {
  title: "Tasks/TaskListView",
  component: TaskListView,
  parameters: { layout: "padded" },
  argTypes: {
    tasks: { control: "object" },
    gates: { control: "object" },
    group: { control: "select", options: ["status", "tags", "initiative", "none"] },
    sort: { control: "object" },
  },
} satisfies Meta<typeof TaskListView>;

export default meta;

type Story = StoryObj<TaskListViewProps>;

export const Playground: Story = {
  args: { tasks, gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Grupos por status, con la fila de gates abiertas arriba. */
export const ByStatus: Story = {
  args: { tasks, gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Grupos por tag: la cabecera lleva el chip en vez del título (`identityChip`). */
export const ByTag: Story = {
  args: { tasks, gates, group: "tags", sort: { key: "title", dir: "asc" } },
};

/** Grupos por initiative. */
export const ByInitiative: Story = {
  args: { tasks, gates, group: "initiative", sort: { key: "updated", dir: "desc" } },
};

/** Sin gates: la sección de gates no se renderiza. */
export const NoGates: Story = {
  args: { tasks, gates: [], group: "status", sort: { key: "updated", dir: "desc" } },
};

/** `group === "none"`: un solo bloque y sin cabecera. */
export const Ungrouped: Story = {
  args: { tasks, gates, group: "none", sort: { key: "id", dir: "desc" } },
};

/** Sin tareas: no queda ni un bloque, pero las gates abiertas siguen visibles. */
export const Empty: Story = {
  args: { tasks: [], gates, group: "status", sort: { key: "updated", dir: "desc" } },
  render: (args) => (
    <div class="flex flex-col gap-3">
      <p class="text-[13px] text-muted">Sin tasks: la vista no renderiza columnas vacías; las gates abiertas sí.</p>
      <TaskListView {...args} />
      <p class="text-[13px] text-faint">— fin —</p>
    </div>
  ),
};

/** Un solo salto al fondo mantiene el lector pegado a través de varios bloques. */
export const LongListSingleJump: Story = {
  args: {
    tasks: Array.from({ length: 125 }, (_, index) => makeTask({
      id: `T-long-list-${String(index + 1).padStart(3, "0")}`,
      title: index % 5 === 0 ? `Long list task ${index + 1}: investigate the responsive state` : `Long list task ${index + 1}`,
      description: index % 7 === 0 ? "A longer description ensures the measured row heights vary as content is learned." : "",
    })),
    gates: [],
    group: "none",
    sort: { key: "id", dir: "asc" },
  },
  render: (args) => (
    <div class="relative h-screen w-full">
      <main class="main-content-view main-content-visible"><TaskListView {...args} /></main>
    </div>
  ),
  play: async () => {
    const scrollRoot = document.querySelector<HTMLElement>(".main-content-view");
    if (!scrollRoot) throw new Error("Falta el scroll root de la lista");
    scrollRoot.scrollTop = scrollRoot.scrollHeight;
    await waitFor(() => expect(document.querySelectorAll('[data-testid="task-row"]').length).toBe(125));
  },
};
