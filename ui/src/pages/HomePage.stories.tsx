import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HomePage } from "./HomePage";

/**
 * Home: tres tarjetas de resumen y "Up next".
 *
 * Los números (12, 4, 8) están escritos a mano: todavía no hay backend. Cuando lo haya, esta página pasa
 * a leer de `@tanstack/solid-query` o `createResource` y los números dejan de ser constantes (Fase 8).
 */
const meta = {
  title: "Pages/HomePage",
  component: HomePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomePage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

export const Playground: Story = {
  render: () => (
    <div class="min-h-screen bg-white">
      <HomePage />
    </div>
  ),
};

/**
 * Angosto: las tres tarjetas pasan a una columna.
 *
 * El corte es `sm:grid-cols-2` (640px) y `lg:grid-cols-3` (1024px) — los breakpoints de Tailwind, no los
 * de la app (639/1023). Están a 1px de distancia, así que a 639 se ve una columna y a 640 se ven dos:
 * es una inconsistencia real, visible sólo en ese píxel.
 */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => (
    <div class="min-h-screen bg-white">
      <HomePage />
    </div>
  ),
};

export const Wide: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => (
    <div class="min-h-screen bg-white">
      <HomePage />
    </div>
  ),
};
