import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { PlaceholderPage } from "./PlaceholderPage";

/**
 * Página de relleno: Knowledges, Gates e Initiatives.
 *
 * Las tres se ven igual, con una cabecera vacía y sin bloque de contenido. En vez de tres archivos
 * iguales hay uno, y el registro lo usa como default para cualquier vista desconocida.
 *
 * Que las tres se vean así es el estado real del producto: son entradas de navegación sin construir.
 * Tenerlas en una sola story es justamente el punto — que se note que son la misma cosa.
 */
const meta = {
  title: "Pages/PlaceholderPage",
  component: PlaceholderPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PlaceholderPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

export const Playground: Story = {
  render: () => (
    <div class="min-h-screen bg-white">
      <PlaceholderPage />
    </div>
  ),
};

