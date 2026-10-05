import { createMemo, createSignal } from "solid-js";
import { emptyFilterTree } from "../data/filters";
import { snapshot } from "../data/source";
import { projectBoard } from "../data/climier/projection";
import { filterTasks } from "../utils/filterTasks";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { isSurfaceOpen, must } from "../../../test-utils/story";

import { TasksToolbar } from "./TasksToolbar";
import type { FilterGroup, TaskGroupBy, TaskScope, TaskSort, TaskView } from "../types";

const { gates, tasks } = projectBoard(snapshot);

/**
 * La toolbar completa.
 *
 * Es la **única** pieza que sabe cuál menú está abierto, y ese único signal es la regla "como máximo
 * uno a la vez". Antes esa regla estaba repartida entre tres funciones que tenían que estar de
 * acuerdo (`toggleSortMenu` cerraba los otros dos, y así); con un solo signal, abrir un menú cierra
 * los demás por construcción.
 *
 * Por eso las stories de abajo no necesitan coordinar nada: se clickea un trigger y los otros se
 * cierran solos.
 */
const meta = {
  title: "Tasks/TasksToolbar",
  component: TasksToolbar,
  parameters: { layout: "fullscreen" },
  argTypes: {
    view: { control: "inline-radio", options: ["list", "kanban"] },
    group: { control: "inline-radio", options: ["status", "tags", "initiative", "none"] },
    sort: { control: "object" },
    onView: { control: false },
    onSort: { control: false },
    onGroup: { control: false },
  },
} satisfies Meta<typeof TasksToolbar>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

const TRIGGER = {
  sort: "[data-sort-trigger]",
  group: "[data-group-trigger]",
  filter: 'button[aria-label="Filter"]',
} as const;

/**
 * Monta la toolbar con su estado.
 *
 * Los menús calculan su posición midiendo su trigger, así que para mostrarlos abiertos hay que
 * clickearlos: eso lo hace el `play` de cada story abierta.
 */
const Host = (props: { view?: TaskView; scope?: TaskScope; sort?: TaskSort; group?: TaskGroupBy; tree?: FilterGroup }) => {
  const [view, setView] = createSignal<TaskView>(props.view ?? "list");
  const [scope, setScope] = createSignal<TaskScope>(props.scope ?? "active");
  const [sort, setSort] = createSignal<TaskSort>(props.sort ?? { key: "updated", dir: "desc" });
  const [group, setGroup] = createSignal<TaskGroupBy>(props.group ?? "status");
  // El árbol vive acá porque en la app vive en la URL: la toolbar lo recibe como valor plano y no sabe de
  // dónde viene. Un signal local hace que los clicks de la story se comporten igual que en la app.
  const [tree, setTree] = createSignal<FilterGroup>(props.tree ?? emptyFilterTree());
  const filteredTasks = createMemo(() => filterTasks(tasks, tree()));
  const filteredGates = createMemo(() => filterTasks(gates, tree()));
  const scopeCounts = createMemo(() => {
    const current = filteredTasks();
    const openGates = filteredGates().length;
    const closed = current.filter((task) => task.status === "done" || task.status === "canceled").length;
    return { active: current.length - closed + openGates, closed, all: current.length + openGates };
  });
  return (
    <div class="bg-white">
      <TasksToolbar view={view()} onView={setView} scope={scope()} scopeCounts={scopeCounts()} onScope={setScope} sort={sort()} onSort={setSort} group={group()} onGroup={setGroup} filterTree={tree()} onFilterTree={setTree} snapshot={snapshot} />
    </div>
  );
};

/** Estado inicial: lista, orden por defecto, agrupado por status. Los tres triggers en `text-muted`. */
export const Playground: Story = {
  args: { view: "list", group: "status" },
  render: () => <Host />,
};

/** Kanban activo. El switch y los botones de la derecha comparten la fila. */
export const KanbanActive: Story = {
  render: () => <Host view="kanban" />,
};

/**
 * Un orden aplicado: el trigger de Sort pasa a `text-ink` y el check del menú se mueve. Los botones
 * de la derecha son los únicos que avisan de estado sin abrirse, así que ese cambio de color es
 * funcional, no decorativo.
 */
export const WithAppliedSortAndGroup: Story = {
  render: () => <Host sort={{ key: "id", dir: "desc" }} group="tags" />,
};

/**
 * Abre el menú que corresponda con un click real y verifica que quedó abierto.
 *
 * Es la regla "como máximo un menú abierto" puesta a prueba desde afuera: el click va al trigger y la
 * aserción mira el `data-open` de la superficie, que es lo que publica `PopoverSurface`.
 */
const openMenu = (key: keyof typeof TRIGGER, surfaceId: string) => async () => {
  await userEvent.click(must(document.querySelector(TRIGGER[key]), `el trigger de ${key}`));
  await waitFor(() => expect(isSurfaceOpen(surfaceId)).toBe(true));
};

/** Menú de orden abierto. */
export const SortOpen: Story = {
  render: () => <Host />,
  play: openMenu("sort", "task-sort-menu"),
};

/** Menú de agrupar abierto: es más chico que el de orden y sin sección de dirección. */
export const GroupOpen: Story = {
  render: () => <Host />,
  play: openMenu("group", "task-group-menu"),
};

/** Panel de filtros abierto, vacío. */
export const FilterOpen: Story = {
  render: () => <Host />,
  play: openMenu("filter", "task-filter-panel"),
};

/**
 * Los tres anchos reales de la app: los breakpoints son los de `style.css` (1023 y 639), **no** los de
 * Tailwind (sm=640, md=768, lg=1024), así que 639 y 1023 son los límites exactos.
 *
 * El cambio importante es que "Sort", "Group" y "Filter" muestran su texto sólo a partir de 900px
 * (`min-[900px]:inline`), que es un cuarto breakpoint que no coincide con ninguno de los otros dos.
 * Por debajo quedan tres iconos sin etiqueta y el `aria-label` es lo único que los nombra: por eso
 * cada uno lo tiene.
 */
export const Wide: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => <Host />,
};

export const Compact: Story = {
  globals: { viewport: { value: "compact" } },
  render: () => <Host />,
};

export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => <Host />,
};

/** Los tres anchos con los iconos sin etiqueta, para verificar que siguen alineados y no desbordan. */
export const NarrowWithPanelOpen: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => <Host />,
  play: openMenu("filter", "task-filter-panel"),
};
