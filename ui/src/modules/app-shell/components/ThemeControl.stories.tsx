import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { ThemeProvider } from "../../core";
import { must, isSurfaceOpen } from "../../../test-utils/story";
import { ThemeControl } from "./ThemeControl";

const meta = {
  title: "AppShell/ThemeControl",
  component: ThemeControl,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ThemeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

const Host = () => (
  <ThemeProvider storage={null}>
    <div class="flex h-12 items-center justify-end bg-canvas px-4">
      <ThemeControl />
    </div>
  </ThemeProvider>
);

export const Playground: Story = {
  render: () => <Host />,
  play: async () => {
    await userEvent.click(must(document.querySelector("[data-theme-trigger]"), "el control de tema"));
    await waitFor(() => expect(isSurfaceOpen("theme-menu")).toBe(true));

    const darkOption = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((option) => option.textContent?.trim() === "Dark");
    await userEvent.click(must(darkOption ?? null, "la opción Dark"));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(darkOption?.getAttribute("aria-checked")).toBe("true");
    });
  },
};
