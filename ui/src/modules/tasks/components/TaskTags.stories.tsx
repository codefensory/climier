import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { UNKNOWN_TAG, makeTask } from "../data/fixtures";
import { TaskTags } from "./TaskTags";
import type { TaskTagsProps } from "./TaskTags";

/**
 * Chips de tags de una tarea.
 *
 * Muestra como máximo 2. Un tag fuera de la paleta curada recibe un tono derivado y estable: antes,
 * el acceso directo al mapa tiraba `TypeError` y se caía la vista entera.
 */
const meta = {
  title: "Tasks/TaskTags",
  component: TaskTags,
  parameters: { layout: "centered" },
  argTypes: { task: { control: "object" } },
} satisfies Meta<typeof TaskTags>;

export default meta;

type Story = StoryObj<TaskTagsProps>;

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[360px] bg-surface px-5 py-3">{props.children}</div>
);

export const Playground: Story = {
  args: { task: makeTask({ tags: ["design", "checkout"] }) },
  render: (args) => <Frame><TaskTags {...args} /></Frame>,
};

/** Un tag que no está en la paleta: recibe un tono derivado, no rompe. */
export const UnknownTag: Story = {
  args: { task: makeTask({ tags: [UNKNOWN_TAG] }) },
  render: (args) => <Frame><TaskTags {...args} /></Frame>,
};

/** Más de 2 tags: sólo se muestran los dos primeros. */
export const MoreThanShown: Story = {
  args: { task: makeTask({ tags: ["design", "checkout", "platform"] }) },
  render: (args) => <Frame><TaskTags {...args} /></Frame>,
};

/** Sin tags: el contenedor no reserva alto. */
export const None: Story = {
  args: { task: makeTask({ tags: [] }) },
  render: (args) => <Frame><TaskTags {...args} /></Frame>,
};
