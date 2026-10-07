import { createSignal, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { ALL_STATUSES, LONG_DESCRIPTION, LONG_TITLE, makeTask } from "../data/fixtures";
import { TaskListRow } from "./TaskListRow";
import type { TaskListRowProps } from "./TaskListRow";

/**
 * Fila de la vista de lista.
 *
 * La fila resuelve tres truncados a la vez —título, descripción y tags— y todos importan: en una
 * lista real los títulos largos son la norma, no la excepción. La story `Extremes` los fuerza.
 */
const meta = {
  title: "Tasks/TaskListRow",
  component: TaskListRow,
  parameters: { layout: "padded" },
  argTypes: { task: { control: "object" } },
} satisfies Meta<typeof TaskListRow>;

export default meta;

type Story = StoryObj<TaskListRowProps>;

/** Una fila vive dentro de un grupo, que es quien aporta el borde y los divisores. */
const Rows = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="overflow-hidden rounded-[10px] border border-line bg-surface">
    <div class="divide-y divide-hairline">{props.children}</div>
  </div>
);

export const Playground: Story = {
  args: { task: makeTask() },
  render: (args) => <Rows><TaskListRow {...args} /></Rows>,
};

/** Todos los estados de task, uno por fila. */
export const StatusMatrix: Story = {
  render: () => (
    <Rows>
      <For each={ALL_STATUSES}>{(status, index) => <TaskListRow task={makeTask({ id: `T-status-${index()}`, status, title: `Status: ${status}` })} />}</For>
    </Rows>
  ),
};

/**
 * Los casos extremos juntos: título de 3 líneas, descripción larga, descripción vacía, contadores en
 * cero y sin tags. Ninguno rompe el layout.
 */
export const Extremes: Story = {
  render: () => (
    <Rows>
      <TaskListRow task={makeTask({ id: "T-long-900", title: LONG_TITLE, description: LONG_DESCRIPTION })} />
      <TaskListRow task={makeTask({ id: "T-long-901", title: "Sin descripción", description: "" })} />
      <TaskListRow task={makeTask({ id: "T-long-902", title: "Todo en cero", notes: 0, refs: 0, blockers: 0, dependents: 0 })} />
      <TaskListRow task={makeTask({ id: "T-long-903", title: "Sin tags", tags: [] })} />
      <TaskListRow task={makeTask({ id: "T-long-904", title: "Todo a la vez", description: "", tags: [], notes: 0, refs: 0, blockers: 0, dependents: 0 })} />
    </Rows>
  ),
};

/** Una lista de 15 filas seguidas: es donde se ve si `tabular-nums` alinea de verdad. */
export const LongList: Story = {
  render: () => (
    <Rows>
      <For each={Array.from({ length: 15 }, (_, index) => index)}>{(index) => (
        <TaskListRow task={makeTask({
          id: `T-list-${100 + index}`,
          status: ALL_STATUSES[index % ALL_STATUSES.length],
          title: `Tarea ${index + 1} del workspace`,
          notes: index,
          refs: index % 4,
          blockers: index % 3,
          dependents: index % 5,
          tags: index % 3 === 0 ? [] : ["design"],
        })} />
      )}</For>
    </Rows>
  ),
};

/**
 * La fila accionable: con `onOpen` se comporta como un botón. Se prueban click y teclado.
 */
export const OpensTask: Story = {
  render: () => {
    const [opened, setOpened] = createSignal<string | null>(null);
    return (
      <div>
        <Rows>
          <TaskListRow task={makeTask({ id: "T-opens-142" })} onOpen={(task) => setOpened(task.id)} />
          <TaskListRow task={makeTask({ id: "T-opens-138", title: "Segunda fila" })} onOpen={(task) => setOpened(task.id)} />
        </Rows>
        <p data-testid="opened" class="mt-2 text-[12px] text-muted">{opened() ?? "none"}</p>
      </div>
    );
  },
  play: async () => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="task-row"]')];
    await expect(rows[0].getAttribute("role")).toBe("button");
    await userEvent.click(rows[0]);
    await waitFor(() => expect(document.querySelector('[data-testid="opened"]')?.textContent).toBe("T-opens-142"));
    rows[1].focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector('[data-testid="opened"]')?.textContent).toBe("T-opens-138"));
  },
};
