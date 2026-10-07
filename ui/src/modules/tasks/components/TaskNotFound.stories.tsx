import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TaskNotFound } from "./TaskNotFound";
import type { TaskNotFoundProps } from "./TaskNotFound";

/**
 * Estado vacío del detalle.
 *
 * Existe como story porque el caso "la URL apunta a una tarea que no está" es tan real como el
 * detalle: un link viejo o un id mal tipeado. Si no se puede ver, no se puede juzgar.
 */
const meta = {
  title: "Tasks/TaskNotFound",
  component: TaskNotFound,
  parameters: { layout: "centered" },
  argTypes: { id: { control: "text" }, onBack: { control: false } },
} satisfies Meta<typeof TaskNotFound>;

export default meta;

type Story = StoryObj<TaskNotFoundProps>;

export const Playground: Story = {
  args: { id: "CLI-999", onBack: () => {} },
  render: (args) => <div class="w-[720px] bg-surface p-8"><TaskNotFound {...args} /></div>,
};

/** Sin id: la URL no traía ninguno, así que el mensaje no puede nombrarlo. */
export const NoId: Story = {
  args: { onBack: () => {} },
  render: (args) => <div class="w-[720px] bg-surface p-8"><TaskNotFound {...args} /></div>,
};
