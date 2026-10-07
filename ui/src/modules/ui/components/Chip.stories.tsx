import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Chip } from "./Chip";
import type { ChipProps } from "./Chip";

/**
 * Píldora de etiqueta.
 *
 * Estaba escrita dos veces: en la opción de un menú de filtro y en la cabecera de un grupo agrupado por
 * label. Recibe fondo y color como strings sueltos, así que `ui` no conoce la paleta de labels ni el
 * tipo `TaskLabelStyle` — eso es de `tasks`.
 */
const meta = {
  title: "UI/Chip",
  component: Chip,
  parameters: { layout: "fullscreen" },
  argTypes: {
    background: { control: "text" },
    color: { control: "text" },
    children: { control: "text" },
  },
} satisfies Meta<typeof Chip>;

export default meta;

type Story = StoryObj<ChipProps>;

export const Playground: Story = {
  args: { background: "var(--color-tone-green-bg)", color: "var(--color-tone-green-ink)", children: "Design" },
  render: (args) => (
    <div class="bg-surface p-6">
      <Chip {...args} />
    </div>
  ),
};

/** Los cuatro tonos de la paleta curada, que son los que puede devolver `taskLabel()`. */
export const Palette: Story = {
  render: () => (
    <div class="flex flex-wrap items-center gap-3 bg-surface p-6">
      {(
        [
          ["green", "Design"],
          ["blue", "Platform"],
          ["amber", "Billing"],
          ["mauve", "Accessibility"],
        ] as const
      ).map(([tone, label]) => (
        <Chip background={`var(--color-tone-${tone}-bg)`} color={`var(--color-tone-${tone}-ink)`}>
          {label}
        </Chip>
      ))}
    </div>
  ),
};

/**
 * Etiqueta larga: el chip trunca pero no crece. Es el `max-w-full` heredado del original, y es lo que
 * evita que un label largo empuje el contador de la fila fuera del panel.
 */
export const LongLabel: Story = {
  render: () => (
    <div class="flex max-w-[240px] flex-wrap items-center gap-3 bg-surface p-6">
      <Chip background="var(--color-tone-blue-bg)" color="var(--color-tone-blue-ink)">
        Infraestructura y despliegues
      </Chip>
    </div>
  ),
};
