import { createSignal, For } from "solid-js";
import { useTaskFilters } from "../controllers/useTaskFilters";
import { FilterPanel } from "./FilterPanel";
import { GroupMenu } from "./GroupMenu";
import { Button } from "../../ui";
import { SortMenu } from "./SortMenu";
import { TasksViewSwitch } from "./TasksViewSwitch";
import type { FilterGroup, TaskGroupBy, TaskScope, TaskScopeCounts, TaskSort, TaskView } from "../types";

export type TasksToolbarProps = {
  view: TaskView;
  onView: (view: TaskView) => void;
  scope: TaskScope;
  scopeCounts: TaskScopeCounts;
  onScope: (scope: TaskScope) => void;
  sort: TaskSort;
  onSort: (sort: TaskSort) => void;
  group: TaskGroupBy;
  onGroup: (group: TaskGroupBy) => void;
  /**
   * Árbol de filtros, controlado desde arriba (en la app, desde la URL).
   *
   * Es el cuarto par de props con la misma forma que los otros tres a propósito: la toolbar los recibe como
   * valores planos y no sabe que hay un router, que es lo que permite montarla en una story sin provider.
   */
  filterTree: FilterGroup;
  onFilterTree: (next: FilterGroup | ((previous: FilterGroup) => FilterGroup)) => void;
};

/** Cuál de los tres menús está abierto. `null` = ninguno. */
type OpenMenu = "sort" | "group" | "filter";

/**
 * Toolbar del board.
 *
 * Es la **única** pieza que sabe cuál menú está abierto, y ese signal es lo que sostiene la regla
 * "como máximo uno a la vez". Antes esa regla estaba repartida: `toggleSortMenu` cerraba el filtro y
 * el grupo, `toggleGroupMenu` cerraba los otros dos, `toggleFilter` cerraba los dos primeros. Tres
 * funciones que tenían que estar de acuerdo entre sí, y la coordinación se rompía si se agregaba un
 * cuarto menú. Con un solo signal, abrir uno cierra los otros por construcción.
 *
 * Como efecto secundario, `SortMenu` y `GroupMenu` quedan sin estado propio de apertura: reciben
 * `isOpen` y avisan con `onOpen`/`onClose`, así que se pueden montar sueltos en una story.
 */
const scopeOptions: { key: TaskScope; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function TasksToolbar(props: TasksToolbarProps) {
  const [openMenu, setOpenMenu] = createSignal<OpenMenu | null>(null);

  const filters = useTaskFilters({
    isOpen: () => openMenu() === "filter",
    setOpen: (open) => setOpenMenu(open ? "filter" : null),
    tree: () => props.filterTree,
    setTree: props.onFilterTree,
  });

  return (
    <div data-testid="tasks-toolbar" class="flex w-full min-w-0 items-center justify-between gap-3">
      <div class="flex min-w-0 shrink-0 items-center gap-2">
        <TasksViewSwitch view={props.view} onView={props.onView} />
        <div class="hidden min-w-0 overflow-x-auto min-[640px]:block">
          <div data-testid="task-scope-control" class="flex w-max shrink-0 items-center gap-[3px] rounded-[10px] bg-subtle p-[3px]">
            <For each={scopeOptions}>{(option) => (
              <Button variant="segment" state={props.scope === option.key ? "active" : "idle"} aria-pressed={props.scope === option.key} onClick={() => props.onScope(option.key)} class="gap-1 px-1.5 text-[12px] sm:px-2">
                {option.label}<span class="tabular-nums text-faint">{props.scopeCounts[option.key]}</span>
              </Button>
            )}</For>
          </div>
        </div>
        <div class="shrink-0 min-[640px]:hidden">
          <select aria-label="Task scope" value={props.scope} onChange={(event) => props.onScope(event.currentTarget.value as TaskScope)} class="h-8 w-[156px] rounded-[8px] border border-line bg-white px-2 text-[12px] text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink">
            <For each={scopeOptions}>{(option) => <option value={option.key}>{option.label} · {props.scopeCounts[option.key]}</option>}</For>
          </select>
        </div>
      </div>
      <div class="flex min-w-0 shrink-0 items-center gap-1.5"><div data-testid="tasks-controls" class="flex shrink-0 items-center gap-1">
        <SortMenu sort={props.sort} onSort={props.onSort} isOpen={() => openMenu() === "sort"} onOpen={() => setOpenMenu("sort")} onClose={() => setOpenMenu(null)} />
        <GroupMenu group={props.group} onGroup={props.onGroup} isOpen={() => openMenu() === "group"} onOpen={() => setOpenMenu("group")} onClose={() => setOpenMenu(null)} />
        <FilterPanel filters={filters} isOpen={() => openMenu() === "filter"} setOpen={(open) => setOpenMenu(open ? "filter" : null)} />
      </div></div>
    </div>
  );
}
