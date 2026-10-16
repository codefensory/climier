import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { GatesPage } from "./GatesPage";

/**
 * Registry de gates: agrupado por iniciativa, con las iniciativas terminadas (100% de sus gates
 * resueltas o superseded) ocultas por defecto. La `play` verifica ese default y el botón que las revela.
 */
const meta = {
  title: "Pages/GatesPage",
  component: GatesPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GatesPage>;

export default meta;
type Story = StoryObj<Record<string, unknown>>;

const Host = (props: { path?: string }) => (
  <StoryShell path={props.path ?? "/gates"}>
    <div class="min-h-screen bg-surface">
      <GatesPage />
    </div>
  </StoryShell>
);

export const Dark: Story = {
  globals: { theme: "dark" },
  render: () => <Host />,
};

/** En el fixture, `docs` y `growth` están al 100%: no se listan hasta que se pide. */
export const HidesCompletedInitiatives: Story = {
  render: () => <Host />,
  play: async () => {
    const groupKeys = () => [...document.querySelectorAll<HTMLElement>('[data-testid="gate-group"]')].map((group) => group.getAttribute("data-group"));
    await waitFor(() => expect(groupKeys().length).toBeGreaterThan(0));
    await expect(groupKeys()).not.toContain("docs");
    await expect(groupKeys()).not.toContain("growth");

    const toggle = must(document.querySelector<HTMLElement>('[data-testid="gates-show-completed"]'), "el botón de iniciativas completadas");
    await expect(toggle.textContent?.trim()).toBe("Show 2 completed");

    await userEvent.click(toggle);
    await waitFor(() => expect(groupKeys()).toContain("docs"));
    await expect(groupKeys()).toContain("growth");
    await expect(toggle.textContent?.trim()).toBe("Show less");
    await expect(window.location.hash).toContain("completed=1");
  },
};

/** El estado revelado también es una URL: recargar `?completed=1` mantiene las completadas a la vista. */
export const CompletedFromUrl: Story = {
  render: () => <Host path="/gates?completed=1" />,
  play: async () => {
    const groupKeys = () => [...document.querySelectorAll<HTMLElement>('[data-testid="gate-group"]')].map((group) => group.getAttribute("data-group"));
    await waitFor(() => expect(groupKeys()).toContain("docs"));
    await expect(groupKeys()).toContain("growth");
    await expect(must(document.querySelector<HTMLElement>('[data-testid="gates-show-completed"]'), "el botón de iniciativas completadas").textContent?.trim()).toBe("Show less");
  },
};
