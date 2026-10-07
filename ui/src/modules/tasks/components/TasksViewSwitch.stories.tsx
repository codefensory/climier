import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TasksViewSwitch } from "./TasksViewSwitch";
import type { TasksViewSwitchProps } from "./TasksViewSwitch";
import type { TaskView } from "../types";

/**
 * Switch lista/kanban.
 *
 * Es `aria-pressed` y no un `role="tablist"`: no hay paneles asociados, son dos botones que cambian
 * de estado. El activo se pinta blanco con una sombra de 1px sobre la píldora gris.
 */
const meta = {
  title: "Tasks/TasksViewSwitch",
  component: TasksViewSwitch,
  parameters: { layout: "centered" },
  argTypes: {
    view: { control: "inline-radio", options: ["list", "kanban"] },
    onView: { control: false },
  },
} satisfies Meta<typeof TasksViewSwitch>;

export default meta;

type Story = StoryObj<TasksViewSwitchProps>;

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="bg-surface p-3">{props.children}</div>
);

export const Playground: Story = {
  args: { view: "list", onView: () => {} },
  render: (args) => <Frame><TasksViewSwitch {...args} /></Frame>,
};

/** Los dos estados juntos, para comparar el indicador: sólo cambia cuál de los dos está pintado. */
export const States: Story = {
  render: () => (
    <Frame>
      <div class="flex flex-col gap-3">
        <TasksViewSwitch view="list" onView={() => {}} />
        <TasksViewSwitch view="kanban" onView={() => {}} />
      </div>
    </Frame>
  ),
};

/** El estado vive en la story: hacer clic mueve el indicador. */
export const Interactive: Story = {
  render: () => {
    const [view, setView] = createSignal<TaskView>("list");
    return <Frame><TasksViewSwitch view={view()} onView={setView} /></Frame>;
  },
};
