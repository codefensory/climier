import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ProjectsPage } from "./ProjectsPage";

/**
 * Projects.
 *
 * **Esta página no es alcanzable en la app**: el sidebar no tiene entrada de Projects, así que nada llama
 * a `setActiveView("Projects")`. La story existe porque es la única forma de verla — sin ella, código
 * que se conserva quedaría sin ninguna verificación.
 *
 * Se conserva en vez de borrarse porque borrar código muerto es una decisión aparte de una extracción de
 * fases. El día que se borre, se van los tres juntos: esta página, su story, `AppIcon` (el SVG hecho a
 * mano que sólo usa ella) y su entrada en el registro de páginas.
 */
const meta = {
  title: "Pages/ProjectsPage",
  component: ProjectsPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProjectsPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

export const Playground: Story = {
  render: () => (
    <div class="min-h-screen bg-white">
      <ProjectsPage />
    </div>
  ),
};
