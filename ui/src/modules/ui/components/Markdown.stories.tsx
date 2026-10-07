import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, waitFor } from "storybook/test";
import { Markdown } from "./Markdown";
import type { MarkdownProps } from "./Markdown";

/**
 * Render de markdown y su fuente cruda.
 *
 * El parser vive en `core` (`parseMarkdown`) y es puro; acá se prueba el DOM que produce, que es lo
 * que ningún test de string ve: un `<strong>`, un link con `rel`, y que el HTML crudo **no** se
 * interprete.
 */
const meta = {
  title: "UI/Markdown",
  component: Markdown,
  parameters: { layout: "fullscreen" },
  argTypes: { source: { control: "text" }, raw: { control: "boolean" }, class: { control: false } },
} satisfies Meta<typeof Markdown>;

export default meta;

type Story = StoryObj<MarkdownProps>;

const Column = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[620px] bg-surface p-6">{props.children}</div>
);

const SOURCE = [
  "## Recovery plan",
  "",
  "Keep the **cart** and the *coupon* when a payment fails.",
  "",
  "- no new tokens",
  "- a `retry` action",
  "- see [docs/checkout.md](https://example.com/checkout.md)",
  "",
  "> The failure explains itself without support.",
  "",
  "```ts",
  "const retry = () => navigate(`/checkout/${id}`);",
  "```",
  "",
  "---",
].join("\n");

export const Playground: Story = {
  args: { source: SOURCE, class: "text-[14px] leading-[22px] text-ink-soft" },
  render: (args) => <Column><Markdown {...args} /></Column>,
  play: async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="markdown"] strong')?.textContent).toBe("cart"));
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="markdown"] a');
    await expect(link?.getAttribute("href")).toBe("https://example.com/checkout.md");
    await expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    await expect(document.querySelector('[data-testid="markdown"] pre')?.textContent).toContain("const retry");
  },
};

/** El mismo fuente en crudo: el markdown queda a la vista, sin interpretar. */
export const Raw: Story = {
  args: { source: SOURCE, raw: true, class: "text-[12px] leading-[18px] text-ink-soft" },
  render: (args) => <Column><Markdown {...args} /></Column>,
  play: async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="markdown-raw"]')?.textContent).toContain("## Recovery plan"));
    await expect(document.querySelector('[data-testid="markdown"]')).toBeNull();
  },
};

/**
 * Un link con esquema inseguro no se convierte en `<a>`: si el parser no lo entiende, sigue siendo
 * texto. Es la defensa contra `javascript:` y contra HTML crudo, probada en el DOM.
 */
export const UnsafeAndRawHtml: Story = {
  args: {
    source: "Read [this](javascript:alert(1)) and <img src=x onerror=alert(1)> while you are at it.",
    class: "text-[14px] leading-[22px] text-ink-soft",
  },
  render: (args) => <Column><Markdown {...args} /></Column>,
  play: async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="markdown"]')).not.toBeNull());
    await expect(document.querySelector('[data-testid="markdown"] a')).toBeNull();
    await expect(document.querySelector('[data-testid="markdown"] img')).toBeNull();
    await expect(document.querySelector('[data-testid="markdown"]')?.textContent).toContain("javascript:alert(1)");
  },
};
