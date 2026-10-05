import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountPage } from "./AccountPage";

/**
 * Account: los datos del perfil, en filas separadas por línea.
 *
 * Los valores son fijos. Cuando haya backend, estas filas pasan a un formulario (Fase 8).
 */
const meta = {
  title: "Pages/AccountPage",
  component: AccountPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AccountPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

export const Playground: Story = {
  render: () => (
    <div class="min-h-screen bg-white">
      <AccountPage />
    </div>
  ),
};

/**
 * Angosto: el ancho máximo de 620px no llega a apretar, así que la página se ve igual. La story está para
 * dejar constancia de eso y no para mostrar un cambio.
 */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => (
    <div class="min-h-screen bg-white">
      <AccountPage />
    </div>
  ),
};
