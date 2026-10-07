import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { must } from "../../../test-utils/story";
import { makeTask } from "../data/fixtures";
import { STATUS_TOKENS, statusOrder } from "../data/statuses";
import { GroupHeader } from "./GroupHeader";
import type { GroupHeaderProps } from "./GroupHeader";
import type { TaskGroupView } from "../types";

/**
 * Cabecera de grupo.
 *
 * Fondo y borde inferior salen del **mismo** `color` del grupo con `tint()` a 7% y 15%: un token por
 * grupo, dos intensidades.
 *
 * El progreso **ya viene calculado** en `group.progress` (avance promedio del trabajo vigente, ver
 * `groupProgress()` en la proyección); el header sólo lo dibuja.
 */
const meta = {
  title: "Tasks/GroupHeader",
  component: GroupHeader,
  parameters: { layout: "centered" },
  argTypes: { group: { control: "object" }, collapsible: { control: "boolean" } },
} satisfies Meta<typeof GroupHeader>;

export default meta;

type Story = StoryObj<GroupHeaderProps>;

const group = (over: Partial<TaskGroupView>): TaskGroupView => ({
  key: "in_progress",
  label: "In Progress",
  color: STATUS_TOKENS.in_progress,
  glyph: { kind: "status", status: "in_progress" },
  tasks: [],
  progress: 0,
  ...over,
});

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[560px] overflow-hidden rounded-[10px] border border-line bg-surface">{props.children}</div>
);

const sampleTasks = () => [makeTask({ id: "T-checkout-empty-states" }), makeTask({ id: "T-checkout-recovery-flow" })];

export const Playground: Story = {
  args: { group: group({ tasks: sampleTasks(), progress: 68 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/** Grupo de status: hexágono + nombre. Es el caso por defecto del board. */
export const StatusGroup: Story = {
  args: { group: group({ tasks: sampleTasks(), progress: 68 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/**
 * Grupo de tags: el glyph **es** el nombre (un chip), así que el título se omite con `identityChip`.
 */
export const TagGroup: Story = {
  args: { group: group({ key: "design", label: "design", color: "var(--color-tone-green-ink)", glyph: { kind: "tag", tag: "design" }, identityChip: true, tasks: sampleTasks(), progress: 68 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/** Grupo de initiative. */
export const InitiativeGroup: Story = {
  args: { group: group({ key: "checkout", label: "checkout", color: "var(--color-tone-blue-ink)", glyph: { kind: "initiative", initiative: "checkout" }, tasks: sampleTasks(), progress: 42 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/** Grupo de gates abiertas: icono de gate en el board, **sin barra de progreso** (una gate no avanza). */
export const GateGroup: Story = {
  args: { group: group({ key: "gates", label: "Open gates", color: "var(--color-tone-amber-ink)", glyph: { kind: "gate" }, tasks: sampleTasks(), progress: 0, hideProgress: true }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/** `group === "none"`: un solo grupo con el icono de tarea genérico. */
export const AllGroup: Story = {
  args: { group: group({ key: "all", label: "All tasks", color: "var(--color-faint)", glyph: { kind: "all" }, tasks: sampleTasks(), progress: 100 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/**
 * Variante colapsable: el chevron reemplaza al marcador nativo del `<details>` y rota al abrir.
 *
 * La clase `.disclosure-summary` del `<summary>` (que borra el marcador nativo) es
 * responsabilidad del consumidor; acá se replica el par completo para documentar la variante.
 */
export const Collapsible: Story = {
  render: () => (
    <Frame>
      <details class="group" open={false}>
        <summary class="disclosure-summary cursor-pointer">
          <GroupHeader group={group({ tasks: sampleTasks(), progress: 68 })} collapsible />
        </summary>
        <div class="px-4 py-3 text-[13px] text-muted">Two tasks</div>
      </details>
    </Frame>
  ),
  play: async () => {
    const summary = must(document.querySelector<HTMLElement>("details > summary"), "el summary del grupo");
    const chevron = must(summary.querySelector("svg"), "el chevron del summary");
    await expect(getComputedStyle(summary).display).toBe("block");
    const collapsed = getComputedStyle(chevron).rotate;
    await userEvent.click(summary);
    await waitFor(() => expect(summary.closest("details")?.hasAttribute("open")).toBe(true));
    await waitFor(() => expect(getComputedStyle(chevron).rotate).not.toBe(collapsed));
  },
};

/** Grupo vacío: el progreso es 0, no `NaN`. */
export const EmptyGroup: Story = {
  args: { group: group({ tasks: [], progress: 0 }) },
  render: (args) => <Frame><GroupHeader {...args} /></Frame>,
};

/** Los tres extremos del progreso. */
export const ProgressExtremes: Story = {
  render: () => (
    <div class="flex flex-col gap-3">
      <Frame><GroupHeader group={group({ key: "p0", label: "0% — nada empezado", tasks: sampleTasks(), progress: 0 })} /></Frame>
      <Frame><GroupHeader group={group({ key: "p50", label: "50% — a medio camino", tasks: sampleTasks(), progress: 50 })} /></Frame>
      <Frame><GroupHeader group={group({ key: "p100", label: "100% — todo listo", tasks: sampleTasks(), progress: 100 })} /></Frame>
    </div>
  ),
};

/** Todos los grupos de status juntos, derivados de `statusOrder`. */
export const AllStatusGroups: Story = {
  render: () => (
    <div class="flex flex-col gap-3">
      <For each={statusOrder}>{(entry) => (
        <Frame><GroupHeader group={group({ key: entry.status, label: entry.label, color: entry.color, glyph: { kind: "status", status: entry.status }, tasks: sampleTasks(), progress: 20 })} /></Frame>
      )}</For>
    </div>
  ),
};
