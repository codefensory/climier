import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import FilterIcon from "@hugeicons/core-free-icons/FilterIcon";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import { For, Show, type JSX } from "solid-js";
import { HugeIcon } from "../../core";
import { Button, MenuOption, PopoverSurface } from "../../ui";
import { FilterOptionContent } from "./FilterOptionContent";
import type { TaskFiltersController } from "../controllers/useTaskFilters";
import type { FilterCondition, FilterGroup, FilterJoin, FilterOption } from "../types";

export type FilterPanelProps = {
  /** El controlador del filtro: árbol, menú de opciones y posición del panel. */
  filters: TaskFiltersController;
  /** El estado abierto/cerrado lo tiene `TasksToolbar`, para que no haya dos menús abiertos. */
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
};

/**
 * Botón de filtro + panel con el árbol de condiciones + menú de opciones de una fila.
 *
 * El panel no se cierra al elegir un valor: filtrar es iterativo y cerrar en cada cambio obligaría a
 * reabrir. Lo que sí cierra es el menú de opciones, porque ya cumplió.
 *
 * El badge del botón cuenta **todas** las condiciones del árbol, incluidas las de subgrupos, así que
 * un filtro escondido en un subgrupo igual se ve desde afuera.
 */
export function FilterPanel(props: FilterPanelProps) {
  const filters = props.filters;

  /** Resumen del valor de una fila: con varios valores muestra el primero y un `+N`. */
  const valueSummary = (condition: FilterCondition) => {
    const selected = filters.selectedValues(condition);
    if (!selected.length) return "Choose value";
    if (filters.fieldFor(condition).operators.find((operator) => operator.value === condition.operator)?.multiple) return <span class="flex min-w-0 items-center gap-1">{selected[0].chip || selected[0].status ? <FilterOptionContent option={selected[0]} /> : <span class="truncate">{selected[0].label}</span>}{selected.length > 1 && <span class="shrink-0 rounded-full bg-subtle px-1.5 text-[11px] text-muted">+{selected.length - 1}</span>}</span>;
    return <FilterOptionContent option={selected[0]} />;
  };

  const renderGroup = (group: FilterGroup, nested = false): JSX.Element => {
    const childCount = group.conditions.length + group.groups.length;
    /** El conector `And`/`Or` sólo aparece a partir de la segunda fila; antes es un hueco alineado. */
    const connector = (hasPrevious: boolean, join: FilterJoin, rowLabel: string, toggle: () => void) => hasPrevious ? <button type="button" aria-label={`Change connector for ${rowLabel}: ${join === "and" ? "And" : "Or"} — switch to ${join === "and" ? "Or" : "And"}`} onClick={toggle} class="flex h-6 shrink-0 items-center rounded-[6px] bg-subtle px-2 text-[12px] text-muted transition hover:bg-separator hover:text-ink focus-visible:outline-2 focus-visible:outline-ink max-[639px]:px-1">{join === "and" ? "And" : "Or"}</button> : <span aria-hidden="true" class="block h-6 w-11 shrink-0 max-[639px]:w-8" />;
    const renderCondition = (condition: FilterCondition, index: number) => {
      const field = () => filters.fieldFor(condition);
      const operator = () => field().operators.find((item) => item.value === condition.operator) ?? field().operators[0];
      const selected = () => filters.selectedValues(condition);
      const valueContent = () => {
        const option = selected()[0];
        if (!option) return <span class="truncate text-faint">Choose value</span>;
        if (option.status || option.chip) return valueSummary(condition);
        return <span class="flex min-w-0 items-center gap-1.5"><HugeIcon icon={condition.field === "claimed" ? UserIcon : condition.field === "initiative" ? Rocket01Icon : BookOpen01Icon} class="h-3.5 w-3.5 shrink-0 text-muted" /><span class="truncate">{option.label}</span>{selected().length > 1 && <span class="shrink-0 rounded-full bg-subtle px-1.5 text-[11px] text-muted">+{selected().length - 1}</span>}</span>;
      };
      return <div data-testid="filter-condition" class="flex min-w-0 items-center gap-0">
        <div class="flex h-8 w-11 shrink-0 items-center justify-center max-[639px]:w-8">{connector(index > 0, condition.join, field().label, () => filters.toggleConditionJoin(condition.id))}</div>
        <div class="flex h-8 min-w-0 flex-1 overflow-hidden rounded-[8px] border border-line bg-surface">
          <button type="button" data-filter-picker aria-label={`Field: ${field().label}`} onClick={(event) => filters.openPicker(event, condition.id, "field")} class="flex h-full max-w-[150px] min-w-0 shrink-0 items-center gap-1.5 border-r border-separator px-2 text-left text-[12px] text-ink-soft transition hover:bg-canvas focus-visible:relative focus-visible:outline-2 focus-visible:outline-ink cursor-pointer"><HugeIcon icon={field().icon} class="h-3.5 w-3.5 shrink-0 text-muted" /><span class="min-w-0 truncate">{field().label}</span></button>
          <button type="button" data-filter-picker aria-label={`Operator: ${operator().label}`} onClick={(event) => filters.openPicker(event, condition.id, "operator")} class="flex h-full max-w-[150px] min-w-0 shrink-0 items-center border-r border-separator px-2 text-left text-[12px] text-muted transition hover:bg-canvas focus-visible:relative focus-visible:outline-2 focus-visible:outline-ink cursor-pointer"><span class="truncate">{operator().label}</span></button>
          <button type="button" data-filter-picker aria-label={`Value: ${selected().map((item) => item.label).join(", ") || "Choose value"}`} onClick={(event) => filters.openPicker(event, condition.id, "value")} class="flex h-full min-w-0 flex-1 items-center gap-1.5 border-r border-separator px-2 text-left text-[12px] text-ink-soft transition hover:bg-canvas focus-visible:relative focus-visible:outline-2 focus-visible:outline-ink cursor-pointer"><span class="min-w-0 flex-1 truncate">{valueContent()}</span></button>
          <button type="button" aria-label="Remove condition" onClick={() => filters.removeCondition(group.id, condition.id)} class="flex h-full w-8 shrink-0 items-center justify-center text-[18px] leading-none text-faint transition hover:bg-canvas hover:text-ink focus-visible:relative focus-visible:outline-2 focus-visible:outline-ink cursor-pointer">×</button>
        </div>
      </div>;
    };
    const addRow = <div class="flex min-w-0 items-center gap-0">
      <Show when={childCount > 0}><span aria-hidden="true" class="block h-8 w-11 shrink-0 max-[639px]:w-8" /></Show>
      <div class="flex min-w-0 items-center gap-1.5">
        <button type="button" onClick={() => filters.addCondition(group.id)} class="flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-[13px] font-medium text-ink transition hover:bg-canvas focus-visible:outline-2 focus-visible:outline-ink"><HugeIcon icon={Add01Icon} class="h-3.5 w-3.5" />Add filter</button>
        <Show when={!nested && childCount > 0 && !group.groups.length}><button type="button" onClick={filters.addGroup} class="flex h-7 items-center rounded-[6px] px-1.5 text-[12px] text-muted transition hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">Add group</button></Show>
      </div>
    </div>;
    return <div classList={{ "flex min-w-0 flex-1 rounded-[10px] border border-line bg-raised p-1.5": nested }} data-testid={nested ? "filter-subgroup" : "filter-group"}>
      <div classList={{ "min-w-0 flex-1 space-y-1.5": nested, "space-y-1.5": !nested }}>
        <For each={group.conditions}>{(condition, index) => renderCondition(condition, index())}</For>
        <For each={group.groups}>{(child, index) => <div class="flex min-w-0 items-start gap-0"><div class="flex h-8 w-11 shrink-0 items-center justify-center max-[639px]:w-8">{connector(group.conditions.length + index() > 0, child.join, "group", () => filters.toggleGroupJoin(child.id))}</div>{renderGroup(child, true)}</div>}</For>
        {addRow}
      </div>
      <Show when={nested}><div class="flex w-[36px] shrink-0 justify-center"><button type="button" aria-label="Remove group" title="Remove group" onClick={() => filters.removeGroup(group.id)} class="mt-1 flex h-6 w-6 items-center justify-center rounded-[6px] text-[18px] leading-none text-faint transition hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">×</button></div></Show>
    </div>;
  };

  return (
    <>
      <Button variant="ghost" class="relative" state={props.isOpen() ? "open" : "idle"} ref={filters.registerPanelTrigger} aria-label="Filter" aria-haspopup="dialog" aria-expanded={props.isOpen()} aria-controls="task-filter-panel" aria-pressed={props.isOpen()} onClick={(event) => { filters.toggle(event); queueMicrotask(filters.repositionPanel); }}>
        <HugeIcon icon={FilterIcon} class="h-4 w-4 shrink-0" /><span class="hidden min-[900px]:inline">Filter</span><Show when={filters.conditionCount() > 0}><span aria-hidden="true" class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-surface bg-muted px-1 text-[10px] font-semibold leading-none text-on-strong">{filters.conditionCount()}</span></Show>
      </Button>
      <PopoverSurface variant="panel" open={props.isOpen()} left={filters.panelPosition().left} top={filters.panelPosition().top} role="dialog" label="Task filters" id="task-filter-panel" testId="task-filter-panel">
        <div class="mb-2 flex items-center justify-between"><div class="flex items-center gap-2"><h2 class="text-[13px] font-medium text-ink">Filters</h2><Show when={filters.conditionCount() > 0}><span class="rounded-full bg-subtle px-1.5 py-0.5 text-[11px] tabular-nums text-muted">{filters.conditionCount()}</span></Show></div><button type="button" disabled={filters.conditionCount() === 0} onClick={filters.clearAll} class="rounded-[6px] px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted">Clear all</button></div>
        {renderGroup(filters.tree())}
      </PopoverSurface>
      <PopoverSurface variant="menuFit" open={filters.menuOpen()} left={filters.menuPosition().left} top={filters.menuPosition().top} role="listbox" label={filters.renderedMenuKind() === "field" ? "Filter field" : filters.renderedMenuKind() === "operator" ? "Filter operator" : "Filter value"} filterOptionMenu>
        <For each={filters.renderedMenuOptions()}>{(option: FilterOption) => <MenuOption selected={filters.renderedMenuSelected(option)} onSelect={() => filters.chooseOption(option)} leading={<Show when={filters.renderedMenuKind() === "field"}><HugeIcon icon={filters.fields().find((item) => item.id === option.value)?.icon ?? Task01Icon} class="h-3.5 w-3.5 shrink-0 text-muted" /></Show>} label={<FilterOptionContent option={option} />} />}</For>
      </PopoverSurface>
    </>
  );
}
