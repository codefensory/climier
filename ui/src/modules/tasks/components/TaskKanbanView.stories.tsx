import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, waitFor } from "storybook/test";
import { gates, tasks } from "../data/tasks";
import { makeTask } from "../data/fixtures";
import { TaskKanbanView } from "./TaskKanbanView";
import type { TaskKanbanViewProps } from "./TaskKanbanView";

/**
 * Vista kanban: una columna por grupo, con scroll horizontal, y las gates abiertas en una fila
 * aparte arriba.
 *
 * A diferencia de la lista, acá la cabecera **siempre** se muestra, incluso con `group === "none"`.
 * Las columnas tienen un alto mínimo de `calc(100vh - 180px)` que reserva el chrome de la app
 * (breadcrumb + toolbar); en la story ese chrome no existe, así que el alto sobra.
 */
const meta = {
  title: "Tasks/TaskKanbanView",
  component: TaskKanbanView,
  parameters: { layout: "fullscreen" },
  argTypes: {
    tasks: { control: "object" },
    gates: { control: "object" },
    group: { control: "select", options: ["status", "tags", "initiative", "none"] },
    sort: { control: "object" },
  },
} satisfies Meta<typeof TaskKanbanView>;

export default meta;

type Story = StoryObj<TaskKanbanViewProps>;

export const Playground: Story = {
  args: { tasks, gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Las columnas del flujo, con la fila de gates abiertas arriba. */
export const ByStatus: Story = {
  args: { tasks, gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Columnas por tag. */
export const ByTag: Story = {
  args: { tasks, gates, group: "tags", sort: { key: "title", dir: "asc" } },
};

/** Columnas por initiative. */
export const ByInitiative: Story = {
  args: { tasks, gates, group: "initiative", sort: { key: "updated", dir: "desc" } },
};

/** Sin gates: la fila de gates no se renderiza. */
export const NoGates: Story = {
  args: { tasks, gates: [], group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Una sola columna con cabecera "All tasks". */
export const Ungrouped: Story = {
  args: { tasks, gates, group: "none", sort: { key: "id", dir: "desc" } },
};

/** Sin tareas: quedan las columnas vacías y las gates abiertas. */
export const Empty: Story = {
  args: { tasks: [], gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Una sola tarea: las columnas restantes se sostienen vacías y el ancho no se encoge. */
export const SingleTask: Story = {
  args: { tasks: tasks.slice(0, 1), gates, group: "status", sort: { key: "updated", dir: "desc" } },
};

/** Done y canceled no aparecen como columnas ni como tarjetas, aunque lleguen en los datos. */
export const ClosedStatusesHidden: Story = {
  args: {
    tasks: [
      makeTask({ id: "T-visible-ready", status: "ready" }),
      makeTask({ id: "T-hidden-done", status: "done" }),
      makeTask({ id: "T-hidden-canceled", status: "canceled" }),
      makeTask({ id: "T-visible-archived", status: "archived" }),
    ],
    gates: [],
    group: "status",
    sort: { key: "updated", dir: "desc" },
  },
  play: async () => {
    await waitFor(() => {
      expect(document.querySelector('[data-status="done"]')).toBeNull();
      expect(document.querySelector('[data-status="canceled"]')).toBeNull();
      expect(document.querySelectorAll('[data-testid="task-card"]').length).toBe(2);
    });
  },
};
