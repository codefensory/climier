import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ALL_STATUSES, LONG_DESCRIPTION, LONG_TITLE, makeGate, makeTask } from "../data/fixtures";
import { KanbanCard } from "./KanbanCard";
import type { KanbanCardProps } from "./KanbanCard";

/**
 * Tarjeta de la vista kanban.
 *
 * Diferencia deliberada con la fila de lista: el status se oculta y sólo aparece por debajo de
 * 639px. En la columna es redundante, pero al apilarse en pantallas angostas esa pista se pierde y
 * por eso vuelve. Para verlo hay que mirar la story `NarrowStatus`.
 *
 * La tarjeta sirve para tasks y gates (`kind`): una gate muestra su `purpose`.
 */
const meta = {
  title: "Tasks/KanbanCard",
  component: KanbanCard,
  parameters: { layout: "padded" },
  argTypes: { task: { control: "object" } },
} satisfies Meta<typeof KanbanCard>;

export default meta;

type Story = StoryObj<KanbanCardProps>;

/** El ancho de la columna, para juzgar la tarjeta con el alto de línea real. */
const Column = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="flex w-[300px] flex-col gap-2 rounded-[10px] border border-line bg-raised p-2">{props.children}</div>
);

export const Playground: Story = {
  args: { task: makeTask() },
  render: (args) => <Column><KanbanCard {...args} /></Column>,
};

/**
 * Título y descripción largos.
 *
 * La tarjeta clampa la descripción a 2 líneas pero **no** el título: un título de 3 líneas estira la
 * tarjeta y desalinea la columna contra sus vecinas.
 */
export const LongContent: Story = {
  args: { task: makeTask({ id: "T-long-900", title: LONG_TITLE, description: LONG_DESCRIPTION }) },
  render: (args) => <Column><KanbanCard {...args} /></Column>,
};

/** Una gate abierta: chip de `Gate · purpose` arriba del título. */
export const Gate: Story = {
  args: { task: makeGate() },
  render: (args) => <Column><KanbanCard {...args} /></Column>,
};

/** Una task con claim stale: la señal de coordinación más importante del board. */
export const StaleClaim: Story = {
  args: { task: makeTask({ status: "in_progress", progress: 50, claimedBy: "climier-worker-2", claimStale: true }) },
  render: (args) => <Column><KanbanCard {...args} /></Column>,
};

/** Sin tags y con los contadores en cero: la tarjeta conserva el pie con la línea divisoria. */
export const Minimal: Story = {
  args: { task: makeTask({ tags: [], notes: 0, refs: 0, blockers: 0, dependents: 0 }) },
  render: (args) => <Column><KanbanCard {...args} /></Column>,
};

/** Una columna de 8 tarjetas, que es como se las evalúa de verdad: apiladas. */
export const ColumnOfCards: Story = {
  render: () => (
    <Column>
      <For each={ALL_STATUSES}>{(status, index) => <KanbanCard task={makeTask({ id: `T-card-${index()}`, status, title: `Tarjeta ${index() + 1}` })} />}</For>
    </Column>
  ),
};

/**
 * A 380px el status reaparece (breakpoint `max-[639px]`): el glyph se ve en el pie, entre el id y la
 * fecha.
 */
export const NarrowStatus: Story = {
  name: "Pie de tarjeta con status",
  render: () => (
    <div class="w-[380px]">
      <Column>
        <KanbanCard task={makeTask({ status: "blocked" })} />
      </Column>
    </div>
  ),
};
