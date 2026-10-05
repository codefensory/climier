import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SessionProvider, type StorageLike } from "../modules/core";
import { LoginPage } from "./LoginPage";

function emptyStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

const meta = {
  title: "Pages/LoginPage",
  component: LoginPage,
  render: () => <SessionProvider storage={emptyStorage()}><LoginPage /></SessionProvider>,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LoginPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
