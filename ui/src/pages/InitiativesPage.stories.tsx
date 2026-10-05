import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { decodeFilterTree } from "../modules/tasks";
import { snapshot } from "../modules/tasks/data/source";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { InitiativesPage } from "./InitiativesPage";

/**
 * Initiatives: el trabajo agrupado por iniciativa.
 *
 * Al elegir una, navega a `/tasks` con el mismo árbol de filtros que escribe el panel, así que la
 * vista de tasks se abre acotada y el estado es compartible. La `play` verifica justamente eso: que
 * el click escriba un filtro por iniciativa decodificable.
 */
const meta = {
  title: "Pages/InitiativesPage",
  component: InitiativesPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InitiativesPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

const Host = () => (
  <StoryShell path="/initiatives">
    <div class="min-h-screen bg-white">
      <InitiativesPage />
    </div>
  </StoryShell>
);

export const Playground: Story = {
  render: () => <Host />,
};

/** Abrir una iniciativa navega a `/tasks` con un filtro por esa iniciativa. */
export const OpensFilteredTasks: Story = {
  render: () => <Host />,
  play: async () => {
    const card = must(document.querySelector<HTMLElement>('[data-testid="initiative-card"]'), "la primera tarjeta de iniciativa");
    const name = card.getAttribute("data-initiative") ?? "";
    await expect(name.length).toBeGreaterThan(0);
    await userEvent.click(card);
    await waitFor(() => expect(window.location.hash).toContain("/tasks?filter="));

    const raw = decodeURIComponent(window.location.hash.split("filter=")[1] ?? "");
    const tree = decodeFilterTree(raw, snapshot);
    await expect(tree.conditions.length).toBe(1);
    await expect(tree.conditions[0].field).toBe("initiative");
    await expect(tree.conditions[0].values[0]).toBe(name);
  },
};

/**
 * Progreso y orden por `Updated`.
 *
 * `platform` tiene 2 tasks `done` sobre 5 vigentes más una gate abierta: mostraba 0% cuando el
 * progreso sólo miraba lo abierto, y ahora aporta 33%. `growth` sigue en 0% (nada terminado) y va
 * última por ser la menos reciente; `checkout` abre la lista por ser la que se movió al final.
 */
export const ProgressAndUpdatedOrder: Story = {
  render: () => <Host />,
  play: async () => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="initiative-card"]')];
    const names = cards.map((card) => card.getAttribute("data-initiative"));
    await expect(names[0]).toBe("checkout");
    await expect(names.at(-1)).toBe("growth");

    const progressOf = (name: string) =>
      must(cards.find((card) => card.getAttribute("data-initiative") === name) ?? null, `la tarjeta "${name}"`).getAttribute("data-progress");
    await expect(progressOf("platform")).toBe("33");
    await expect(progressOf("growth")).toBe("0");
  },
};
