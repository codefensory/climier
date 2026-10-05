import { createSignal } from "solid-js";
import { emptyFilterTree } from "../data/filters";
import { snapshot } from "../data/source";
import { projectBoard } from "../data/climier/projection";
import { filterTasks } from "../utils/filterTasks";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TaskBoardContainer } from "../containers/TaskBoardContainer";
import { TasksToolbar } from "../components/TasksToolbar";
import type { FilterGroup, TaskGroupBy, TaskScope, TaskSort, TaskView } from "../types";

const { gates, tasks } = projectBoard(snapshot);

/**
 * Toolbar + board: lo que en la app es la vista de tareas.
 *
 * Existe como story para cubrir el criterio "toolbar en los 3 viewports" en un solo lugar, y porque
 * el **fallback a kanban** no se puede ver en una story de la toolbar sola: `TaskBoardContainer` lee
 * `useMediaQuery(BREAKPOINTS.narrow)` por su cuenta y decide.
 *
 * A 639px o menos se muestra kanban **aunque el switch diga List**. Es una adaptación y no una
 * preferencia del usuario: la lista necesita ancho para los metadatos al costado.
 */
const meta = {
  title: "Tasks/TaskBoardContainer",
  component: TaskBoardContainer,
  parameters: { layout: "fullscreen" },
  argTypes: {
    view: { control: "inline-radio", options: ["list", "kanban"] },
    group: { control: "inline-radio", options: ["status", "tags", "initiative", "none"] },
    sort: { control: "object" },
  },
} satisfies Meta<typeof TaskBoardContainer>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

const Host = (props: { view?: TaskView; scope?: TaskScope; sort?: TaskSort; group?: TaskGroupBy }) => {
  const [view, setView] = createSignal<TaskView>(props.view ?? "list");
  const [scope, setScope] = createSignal<TaskScope>(props.scope ?? "active");
  const [sort, setSort] = createSignal<TaskSort>(props.sort ?? { key: "updated", dir: "desc" });
  const [group, setGroup] = createSignal<TaskGroupBy>(props.group ?? "status");
  const [tree, setTree] = createSignal<FilterGroup>(emptyFilterTree());
  const filtered = () => filterTasks(tasks, tree());
  const filteredGates = () => filterTasks(gates, tree());
  const counts = () => {
    const current = filtered();
    const gateCount = filteredGates().length;
    const closed = current.filter((task) => task.status === "done" || task.status === "canceled").length;
    return { active: current.length - closed + gateCount, closed, all: current.length + gateCount };
  };
  const scopedTasks = () => scope() === "all" ? filtered() : filtered().filter((task) => scope() === "closed" ? task.status === "done" || task.status === "canceled" : task.status !== "done" && task.status !== "canceled");
  const scopedGates = () => scope() === "closed" ? [] : filteredGates();
  return (
    <>
      <TasksToolbar view={view()} onView={setView} scope={scope()} scopeCounts={counts()} onScope={setScope} sort={sort()} onSort={setSort} group={group()} onGroup={setGroup} filterTree={tree()} onFilterTree={setTree} snapshot={snapshot} />
      <div class="tasks-content px-4 pt-4">
        <TaskBoardContainer tasks={scopedTasks()} gates={scopedGates()} view={view()} sort={sort()} group={group()} />
      </div>
    </>
  );
};

export const Playground: Story = {
  args: { view: "list", group: "status" },
  render: () => <Host />,
};

/** Ancho: lista. Los metadatos (id, tags, contadores, fecha) entran al costado de cada fila. */
export const Wide: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host />,
};

/** Compacto (≤1023): la lista sigue, con los metadatos más apretados. */
export const Compact: Story = {
  globals: { viewport: { value: "compact" } },
  render: () => <Host />,
};

/** Angosto (≤639): kanban. Las columnas van a scroll horizontal y el status vuelve al pie de cada tarjeta. */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => <Host />,
};

/** Kanban elegido explícitamente en ancho completo: el switch y la vista coinciden. */
export const KanbanExplicit: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host view="kanban" />,
};

/** Agrupado por tag: las cabeceras llevan el chip en vez del título. */
export const GroupedByTag: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host group="tags" sort={{ key: "title", dir: "asc" }} />,
};

/** Agrupado por initiative. */
export const GroupedByInitiative: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host group="initiative" />,
};
