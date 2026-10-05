import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ALL_STATUSES } from "../data/fixtures";
import { STATUS_TOKENS } from "../data/statuses";
import { StatusGlyph } from "./StatusGlyph";
import type { StatusGlyphProps } from "./StatusGlyph";

/**
 * Hexágono de status, el único SVG propio del proyecto.
 *
 * El hexágono es la misma forma en todas las variantes: lo que cambia es el color y qué va adentro
 * (punteado, medio lleno, flecha, barra, lleno, X, cruz). Cubre tasks y gates.
 */
const meta = {
  title: "Tasks/StatusGlyph",
  component: StatusGlyph,
  parameters: { layout: "centered" },
  argTypes: {
    status: { control: "select", options: ALL_STATUSES },
    class: { control: "text" },
  },
} satisfies Meta<typeof StatusGlyph>;

export default meta;

type Story = StoryObj<StatusGlyphProps>;

export const Playground: Story = {
  args: { status: "in_progress" },
};

/**
 * Todos los estados de task con el token que usa cada uno.
 *
 * El nombre del token se muestra al lado a propósito: es la forma de ver de un vistazo que `ready`,
 * `submitted`, `blocked` y `done` **reutilizan** tokens existentes y no tienen uno propio.
 */
export const AllStatuses: Story = {
  render: () => (
    <div class="flex flex-col gap-2 bg-white p-5">
      <For each={ALL_STATUSES}>{(status) => (
        <div class="flex items-center gap-3">
          <StatusGlyph status={status} class="h-5 w-5 shrink-0" />
          <span class="w-[100px] font-mono text-[12px] text-ink">{status}</span>
          <span class="font-mono text-[11px] text-faint">{STATUS_TOKENS[status]}</span>
        </div>
      )}</For>
    </div>
  ),
};

/** Las gates: abierta, resuelta y superseded. */
export const Gates: Story = {
  render: () => (
    <div class="flex flex-col gap-2 bg-white p-5">
      <For each={["open", "resolved", "superseded"] as const}>{(status) => (
        <div class="flex items-center gap-3">
          <StatusGlyph status={status} class="h-5 w-5 shrink-0" />
          <span class="w-[100px] font-mono text-[12px] text-ink">{status}</span>
          <span class="font-mono text-[11px] text-faint">{STATUS_TOKENS[status]}</span>
        </div>
      )}</For>
    </div>
  ),
};

/** Los 4 tamaños en uso real. `stroke-width` es fijo en 1.5. */
export const Sizes: Story = {
  render: () => (
    <div class="flex items-end gap-4 bg-white p-5">
      <For each={[{ size: "h-3.5 w-3.5", label: "3.5 · kanban" }, { size: "h-4 w-4", label: "4 · fila" }, { size: "h-5 w-5", label: "5 · grupo" }, { size: "h-6 w-6", label: "6 · grande" }]}>{(item) => (
        <div class="flex flex-col items-center gap-2">
          <StatusGlyph status="done" class={`${item.size} shrink-0`} />
          <span class="text-[10px] text-faint">{item.label}</span>
        </div>
      )}</For>
    </div>
  ),
};
