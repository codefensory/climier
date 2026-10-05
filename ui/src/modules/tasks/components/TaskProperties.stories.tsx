import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { makeGate, makeTask } from "../data/fixtures";
import { TaskProperties } from "./TaskProperties";
import type { TaskPropertiesProps } from "./TaskProperties";

/**
 * Propiedades del node, en la columna derecha del detalle.
 *
 * Las stories usan el ancho real de esa columna (240px): el caso que importa es el nombre del claim,
 * que es lo más ancho que entra y lo primero que se rompe si la columna se angosta.
 */
const meta = {
  title: "Tasks/TaskProperties",
  component: TaskProperties,
  parameters: { layout: "centered" },
  argTypes: { task: { control: "object" } },
} satisfies Meta<typeof TaskProperties>;

export default meta;

type Story = StoryObj<TaskPropertiesProps>;

/** El ancho de la columna real del detalle. */
const Rail = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[240px] bg-white p-6">{props.children}</div>
);

export const Playground: Story = {
  args: { task: makeTask({ tags: ["design", "checkout"], status: "in_progress", progress: 50, claimedBy: "climier-worker" }) },
  render: (args) => <Rail><TaskProperties {...args} /></Rail>,
};

/** Tags, Claimed by y Domain sólo aparecen cuando tienen valor. */
export const Empty: Story = {
  args: { task: makeTask({ tags: [], status: "backlog", initiative: null, domain: null }) },
  render: (args) => <Rail><TaskProperties {...args} /></Rail>,
};

/** Claim stale: el nombre va teñido y aparece el chip `stale`. */
export const StaleClaim: Story = {
  args: { task: makeTask({ status: "in_progress", progress: 50, claimedBy: "climier-worker-2", claimStale: true }) },
  render: (args) => <Rail><TaskProperties {...args} /></Rail>,
};

/** Una gate abierta, con su `purpose`. */
export const Gate: Story = {
  args: { task: makeGate({ domain: null }) },
  render: (args) => <Rail><TaskProperties {...args} /></Rail>,
};
