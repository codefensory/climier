import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StoryShell } from "../test-utils/StoryShell";
import { GatesPage } from "./GatesPage";

const meta = {
  title: "Pages/GatesPage",
  component: GatesPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GatesPage>;

export default meta;
type Story = StoryObj<Record<string, unknown>>;

const Host = () => (
  <StoryShell path="/gates">
    <div class="min-h-screen bg-surface">
      <GatesPage />
    </div>
  </StoryShell>
);

export const Dark: Story = {
  globals: { theme: "dark" },
  render: () => <Host />,
};
