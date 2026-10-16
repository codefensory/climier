import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import App from "./App";
import { snapshot } from "./modules/tasks/data/source";
import { must, sidebarItem } from "./test-utils/story";
import { resetStoryStorage, resetStoryUrl } from "./test-utils/StoryShell";

const cleanUrl = async () => {
  resetStoryUrl("/");
  resetStoryStorage();
  return {};
};

const meta = {
  component: App,
  render: () => <App mode="fixture" fixtureSnapshot={snapshot} />,
  loaders: [cleanUrl],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = {};
export const Compact: Story = { globals: { viewport: { value: "compact" } } };
export const Narrow: Story = { globals: { viewport: { value: "narrow" } } };

export const TasksFlow: Story = {
  globals: { viewport: { value: "wide" } },
  play: async () => {
    await userEvent.click(sidebarItem("Tasks"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-toolbar"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-list-view"]')).not.toBeNull());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
  },
};

/**
 * La vista elegida sobrevive a irse, volver y al botón de atrás, y la URL no participa.
 *
 * Es el caso que motivó sacarla del search param: con `?view=kanban`, las entradas del historial
 * (`#/tasks?view=kanban` y `#/tasks`) llevaban vistas distintas, así que atrás caía en lista. Ahora el
 * click **no navega** (el hash sigue en `#/tasks`), Home y Tasks se visitan con la URL limpia, y atrás
 * desde Home vuelve a Tasks en kanban.
 */
export const ViewPreferenceSurvives: Story = {
  globals: { viewport: { value: "wide" } },
  play: async () => {
    await userEvent.click(sidebarItem("Tasks"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-list-view"]')).not.toBeNull());
    const segments = [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view-switch"] button')];
    const kanban = must(segments.find((button) => button.textContent?.trim() === "Kanban") ?? null, "el segmento Kanban");
    await userEvent.click(kanban);
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
    await expect(window.location.hash).toBe("#/tasks");

    await userEvent.click(sidebarItem("Home"));
    await waitFor(() => expect(window.location.hash).toBe("#/"));

    // El atrás vuelve a Tasks: tiene que seguir en kanban, que es el pedido original.
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());

    // Y adelante + volver por el sidebar tampoco la resetea.
    window.history.forward();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    await userEvent.click(sidebarItem("Tasks"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
    await waitFor(() => expect(document.querySelector('[data-testid="tasks-kanban-view"]')).not.toBeNull());
  },
};
