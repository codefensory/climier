import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import type { ClimierSnapshot } from "../data/climier/contract";
import { emptyFilterTree } from "../data/filters";
import { decodeFilterTree } from "../utils/filterTreeParam";
import { TasksToolbar } from "./TasksToolbar";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe("TasksToolbar project filter vocabulary", () => {
  it("replaces filter options when the selected project changes", async () => {
    const first = projectSnapshot("project-one", "alpha-tag", "alpha-initiative", "alice");
    const second = projectSnapshot("project-two", "beta-tag", "beta-initiative", "bob");
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => <ToolbarHarness first={first} second={second} />, host);

    const filterTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="Filter"]');
    expect(filterTrigger).not.toBeNull();
    filterTrigger!.click();
    await settle();

    const addFilter = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add filter"));
    expect(addFilter).not.toBeUndefined();
    addFilter!.click();
    await settle();

    const fieldPicker = document.querySelector<HTMLButtonElement>('[data-filter-picker][aria-label^="Field:"]');
    expect(fieldPicker).not.toBeNull();
    fieldPicker!.click();
    await settle();
    const tagsField = [...document.querySelectorAll<HTMLButtonElement>('[data-filter-option-menu][data-open="true"] [role="option"]')].find((option) => option.textContent?.trim() === "Tags");
    expect(tagsField).not.toBeUndefined();
    tagsField!.click();
    await settle();

    const valuePicker = document.querySelector<HTMLButtonElement>('[data-filter-picker][aria-label^="Value:"]');
    expect(valuePicker).not.toBeNull();
    valuePicker!.click();
    await settle();
    expect(optionLabels()).toContain("alpha-tag");
    expect(optionLabels()).not.toContain("beta-tag");

    host.querySelector<HTMLButtonElement>("[data-switch-project]")!.click();
    await settle();
    expect(optionLabels()).toContain("beta-tag");
    expect(optionLabels()).not.toContain("alpha-tag");
  });

  it("drops a URL value that belongs to the previous project", () => {
    const first = projectSnapshot("project-one", "alpha-tag", "alpha-initiative", "alice");
    const second = projectSnapshot("project-two", "beta-tag", "beta-initiative", "bob");
    const encoded = JSON.stringify({ c: [{ f: "tags", o: "is", v: ["alpha-tag"] }], g: [] });

    expect(decodeFilterTree(encoded, first).conditions[0].values).toEqual(["alpha-tag"]);
    expect(decodeFilterTree(encoded, second).conditions).toHaveLength(0);
  });
});

function ToolbarHarness(props: { first: ClimierSnapshot; second: ClimierSnapshot }) {
  const [snapshot, setSnapshot] = createSignal(props.first);
  const [tree, setTree] = createSignal(emptyFilterTree());
  return (
    <>
      <button type="button" data-switch-project onClick={() => setSnapshot(props.second)}>Switch project</button>
      <TasksToolbar
        view="list"
        onView={() => undefined}
        scope="active"
        scopeCounts={{ active: 1, closed: 0, all: 1 }}
        onScope={() => undefined}
        sort={{ key: "updated", dir: "desc" }}
        onSort={() => undefined}
        group="status"
        onGroup={() => undefined}
        filterTree={tree()}
        onFilterTree={setTree}
        snapshot={snapshot()}
      />
    </>
  );
}

function optionLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-filter-option-menu][data-open="true"] [role="option"]')].map((option) => option.textContent?.trim() ?? "");
}

async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function projectSnapshot(projectId: string, tag: string, initiative: string, claimedBy: string): ClimierSnapshot {
  const taskId = `T-${projectId}`;
  return {
    project: { root: `/tmp/${projectId}`, state_file: `/tmp/${projectId}/state.json`, initialized: true, project_id: projectId },
    generated_at: "2026-10-05T00:00:00.000Z",
    initiatives: { [initiative]: { desc: "", created_at: "2026-10-05T00:00:00.000Z" } },
    nodes: {
      [taskId]: {
        id: taskId,
        kind: "resolvable",
        subkind: "task",
        title: taskId,
        tags: [tag],
        initiative,
        status: "open",
        claim: { by: claimedBy, at: null },
      },
    },
    edges: [],
    derived: { ready: [taskId], blocked: [], backlog: [], openGates: [] },
    last_activity: {},
    summary: {},
    alerts: [],
    recent_activity: [],
  };
}
