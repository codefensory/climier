import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { KnowledgeEgoPanel, KnowledgeRow, KnowledgesToolbar, projectKnowledgeRegistry } from "../modules/tasks";
import type { KnowledgeGroupMode } from "../modules/tasks";
import { snapshot } from "../modules/tasks/data/source";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { KnowledgesPage } from "./KnowledgesPage";

const meta = {
  title: "Pages/KnowledgesPage",
  component: KnowledgesPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof KnowledgesPage>;

export default meta;
type Story = StoryObj<Record<string, unknown>>;

const Host = (props: { path?: string }) => <StoryShell path={props.path ?? "/knowledges"}><div class="bg-white"><KnowledgesPage /></div></StoryShell>;
const sampleKnowledge = () => projectKnowledgeRegistry(snapshot)[0]!;

export const Playground: Story = { render: () => <Host /> };

/** Status segments are data-driven: the fixture offers Active and Deprecated, but no Superseded. */
export const StatusFilterFlow: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host />,
  play: async () => {
    await waitFor(() => expect(document.querySelectorAll('[data-testid="knowledge-row"]').length).toBe(3));
    const active = must([...document.querySelectorAll<HTMLElement>('[data-testid="knowledges-toolbar"] button')].find((button) => button.textContent?.includes("Active")) ?? null, "Active segment");
    await userEvent.click(active);
    await waitFor(() => expect(document.querySelectorAll('[data-testid="knowledge-row"]').length).toBe(2));
    await waitFor(() => expect(window.location.hash).toBe("#/knowledges?status=active"));
  },
};

/** Selecting a registry row persists the key and fills the ego panel. */
export const SelectionFlow: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host />,
  play: async () => {
    const row = must(document.querySelector<HTMLElement>('[data-testid="knowledge-row"]'), "first knowledge row");
    const id = row.dataset.knowledgeId ?? "";
    const title = row.querySelector("h3")?.textContent ?? "";
    await userEvent.click(row);
    await waitFor(() => expect(document.querySelector('[data-testid="knowledge-ego"]')?.textContent).toContain(title));
    await waitFor(() => expect(window.location.hash).toContain(`knowledge=${encodeURIComponent(id)}`));
  },
};

export const Toolbar: Story = {
  render: () => {
    const [status, setStatus] = createSignal("all");
    const [query, setQuery] = createSignal("");
    const [group, setGroup] = createSignal<KnowledgeGroupMode>("initiative");
    return <div class="min-h-screen bg-canvas p-6"><KnowledgesToolbar status={status()} statusOptions={[{ key: "all", label: "All", count: 3 }, { key: "active", label: "Active", count: 2 }, { key: "deprecated", label: "Deprecated", count: 1 }]} onStatus={setStatus} query={query()} onQuery={setQuery} group={group()} onGroup={setGroup} /></div>;
  },
};

export const RegistryRow: Story = {
  render: () => {
    const knowledge = sampleKnowledge();
    return <div class="mx-auto max-w-[900px] p-6"><div role="listbox" aria-label="Knowledges" class="overflow-hidden rounded-[10px] border border-line bg-white"><div role="group" aria-label={knowledge.initiative ?? "No initiative"}><KnowledgeRow knowledge={knowledge} selected={false} onSelect={() => undefined} /></div></div></div>;
  },
};

export const DetailPanel: Story = {
  render: () => <div class="min-h-screen bg-canvas p-6"><div class="mx-auto h-[754px] w-[380px] overflow-hidden rounded-[10px] border border-line bg-white"><KnowledgeEgoPanel knowledge={sampleKnowledge()} onSelect={() => undefined} /></div></div>,
};
