import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import App from "./App";
import { sidebarItem } from "./test-utils/story";
import { resetStoryUrl } from "./test-utils/StoryShell";

const cleanUrl = async () => {
  resetStoryUrl("/");
  return {};
};

const meta = {
  component: App,
  render: () => <App mode="fixture" />,
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
