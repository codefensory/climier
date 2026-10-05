import FilterIcon from "@hugeicons/core-free-icons/FilterIcon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import KanbanIcon from "@hugeicons/core-free-icons/KanbanIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HugeIcon } from "./HugeIcon";

/**
 * Icono de Hugeicons con el peso de trazo del proyecto.
 *
 * Convención del repo (ver `AGENTS.md`): 16px en navegación, toolbars y switchers; 14px para
 * contadores en línea. El trazo acompaña al texto que rodea al icono — nunca debe leerse más
 * pesado que sus vecinos. Las stories `Sizes` y `Grid` existen para revisar eso de un vistazo.
 */
const meta = {
  title: "Core/HugeIcon",
  component: HugeIcon,
  parameters: { layout: "centered" },
  argTypes: {
    icon: { control: false, description: "Asset de Hugeicons" },
    class: { control: "text", description: "Clases del <svg> (define el tamaño)" },
    strokeWidth: {
      control: "select",
      options: ["1.2", "1.4", "1.6", "1.8", "2"],
      description: "Grosor del trazo",
    },
  },
  args: {
    icon: Task01Icon,
    class: "h-6 w-6",
    strokeWidth: "1.6",
  },
} satisfies Meta<typeof HugeIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLES = [
  { label: "Task", icon: Task01Icon },
  { label: "Home", icon: Home01Icon },
  { label: "Kanban", icon: KanbanIcon },
  { label: "Filter", icon: FilterIcon },
  { label: "Settings", icon: Settings01Icon },
];

const SIZES = [
  { label: "12px · h-3", class: "h-3 w-3" },
  { label: "14px · h-3.5", class: "h-3.5 w-3.5" },
  { label: "16px · h-4", class: "h-4 w-4" },
  { label: "20px · h-5", class: "h-5 w-5" },
  { label: "24px · h-6", class: "h-6 w-6" },
];

const STROKES = ["1.2", "1.4", "1.6", "1.8", "2"];

export const Default: Story = {};

export const Sizes: Story = {
  render: () => (
    <div class="flex flex-col gap-3 bg-surface p-6">
      <For each={SIZES}>
        {(size) => (
          <div class="flex items-center gap-4">
            <span class="w-28 shrink-0 text-[11px] text-muted">{size.label}</span>
            <For each={SAMPLES}>
              {(sample) => (
                <span class="text-ink" title={sample.label}>
                  <HugeIcon icon={sample.icon} class={size.class} strokeWidth="1.8" />
                </span>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  ),
};

export const StrokeWeights: Story = {
  render: () => (
    <div class="flex flex-col gap-3 bg-surface p-6">
      <For each={STROKES}>
        {(stroke) => (
          <div class="flex items-center gap-4">
            <span class="w-28 shrink-0 text-[11px] text-muted">stroke-width {stroke}</span>
            <For each={SAMPLES}>
              {(sample) => (
                <span class="text-ink" title={sample.label}>
                  <HugeIcon icon={sample.icon} class="h-4 w-4" strokeWidth={stroke} />
                </span>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  ),
};

/**
 * Matriz completa a 16px: es la vista para decidir si un trazo se lee más pesado que el texto
 * que lo acompaña al mismo tamaño.
 */
export const Grid: Story = {
  render: () => (
    <div class="bg-surface p-6">
      <table class="border-collapse text-[11px] text-muted">
        <thead>
          <tr>
            <th class="pr-4 text-left font-medium">icono</th>
            <For each={STROKES}>{(s) => <th class="px-4 pb-2 font-medium">{s}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={SAMPLES}>
            {(sample) => (
              <tr>
                <td class="pr-4 text-left text-ink">{sample.label}</td>
                <For each={STROKES}>
                  {(stroke) => (
                    <td class="px-4 py-1.5 text-center text-ink">
                      <span class="inline-flex">
                        <HugeIcon icon={sample.icon} class="h-4 w-4" strokeWidth={stroke} />
                      </span>
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  ),
};
