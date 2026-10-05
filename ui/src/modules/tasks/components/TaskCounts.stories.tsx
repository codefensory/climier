import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { makeTask } from "../data/fixtures";
import { TaskCounts } from "./TaskCounts";
import type { TaskCountsProps } from "./TaskCounts";

/**
 * Contadores del DAG: notas, referencias, blockers sin satisfacer y dependents.
 *
 * Cada contador lleva su `aria-label` porque un número suelto no dice de qué es: sin él un lector
 * de pantalla anuncia "4 2 3".
 */
const meta = {
  title: "Tasks/TaskCounts",
  component: TaskCounts,
  parameters: { layout: "centered" },
  argTypes: { task: { control: "object" } },
} satisfies Meta<typeof TaskCounts>;

export default meta;

type Story = StoryObj<TaskCountsProps>;

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="bg-white px-5 py-3">{props.children}</div>
);

export const Playground: Story = {
  args: { task: makeTask({ notes: 4, refs: 2, blockers: 1, dependents: 3 }) },
  render: (args) => <Frame><TaskCounts {...args} /></Frame>,
};

/** Todo en cero: los cuatro iconos siguen ahí y los ceros se leen, no queda un espacio vacío. */
export const Zeros: Story = {
  args: { task: makeTask({ notes: 0, refs: 0, blockers: 0, dependents: 0 }) },
  render: (args) => <Frame><TaskCounts {...args} /></Frame>,
};

/** Números de dos dígitos: `tabular-nums` los alinea en columna entre filas consecutivas. */
export const WideNumbers: Story = {
  args: { task: makeTask({ notes: 12, refs: 34, blockers: 5, dependents: 56 }) },
  render: (args) => <Frame><TaskCounts {...args} /></Frame>,
};
