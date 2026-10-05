import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StoryShell } from "../test-utils/StoryShell";
import { HomePage } from "./HomePage";

const meta = {
  title: "Pages/HomePage",
  component: HomePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<Record<string, unknown>>;
const Host = () => <StoryShell><div class="min-h-screen bg-white"><HomePage /></div></StoryShell>;

export const Playground: Story = { render: () => <Host /> };
export const Narrow: Story = { globals: { viewport: { value: "narrow" } }, render: () => <Host /> };
export const Wide: Story = { globals: { viewport: { value: "wide" } }, render: () => <Host /> };
