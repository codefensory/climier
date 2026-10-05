import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { defaultFilterCondition, filterFields } from "../data/filters";
import type { FilterCondition, FilterField, FilterGroup, FilterMenuKind, FilterMenuSnapshot, FilterMenuState, FilterOption } from "../types";

export type TaskFiltersController = ReturnType<typeof useTaskFilters>;

export type UseTaskFiltersOptions = {
  /** Igual que en `usePopoverMenu`: el estado abierto/cerrado lo tiene `TasksToolbar`. */
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
  /**
   * El árbol de condiciones, **controlado**.
   *
   * Antes este controlador tenía el signal adentro con un `initialTree` para las stories. Desde la Fase 8b el
   * dueño es la URL (`useTasksUrl`), que es lo que hace que el filtro sobreviva a recargar y se pueda
   * compartir. Mismo patrón que `isOpen`/`setOpen`: el controlador sabe cómo editar el árbol, no dónde vive.
   *
   * El setter acepta la forma de updater (`prev => next`) porque todas las ediciones del archivo son
   * relativas al árbol actual.
   */
  tree: () => FilterGroup;
  setTree: (next: FilterGroup | ((previous: FilterGroup) => FilterGroup)) => void;
};

/**
 * Panel de filtros: el árbol de grupos/condiciones, el menú de opciones de una fila, la posición del
 * panel y el descarte.
 *
 * Es el trozo más enredado de la toolbar y por eso el que más gana con estar aparte. Tres detalles
 * que no son obvios:
 *
 * 1. **El panel y el menú de opciones comparten un solo listener de descarte**, y en ese orden:
 *    primero el menú de opciones, después el panel. Con dos listeners separados el orden dependería
 *    del orden de registro, que es exactamente el tipo de cosa que se rompe al reordenar un archivo.
 * 2. **El estado abierto/cerrado del panel lo tiene `TasksToolbar`** (por la regla de un solo menú
 *    abierto), pero el menú de opciones vive acá: no participa de esa regla porque siempre está
 *    dentro del panel. Un `createEffect` cierra el menú cuando el panel se cierra desde afuera, que
 *    es lo que el original hacía dentro de `closeFilter()`.
 * 3. **Los ids se generan con un contador mutable, no con un random.** Un `crypto.randomUUID()` acá
 *    haría que dos renders den distinto y que una story no se pueda comparar consigo misma.
 * 4. **`menuSnapshot` congela las opciones al cerrar.** El menú se anima (opacidad y traslación), así
 *    que el contenido tiene que seguir ahí durante la salida; leyendo del árbol vivo, elegir un campo
 *    vaciaría el menú mientras se desvanece.
 */
export function useTaskFilters(options: UseTaskFiltersOptions) {
  const tree = options.tree;
  const setTree = options.setTree;
  const [panelPosition, setPanelPosition] = createSignal({ left: 0, top: 0 });
  const [menuState, setMenuState] = createSignal<FilterMenuState | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuSnapshot, setMenuSnapshot] = createSignal<FilterMenuSnapshot | null>(null);
  const [menuPosition, setMenuPosition] = createSignal({ left: 0, top: 0 });

  let nextId = 2;
  // Sólo se lee dentro de eventos, nunca durante el render: como signal no aportaría nada.
  let panelTrigger: HTMLButtonElement | undefined;

  // ── Árbol ──────────────────────────────────────────────────────────────────────────────────
  const allConditions = () => {
    const collect = (group: FilterGroup): FilterCondition[] => [...group.conditions, ...group.groups.flatMap(collect)];
    return collect(tree());
  };
  const conditionCount = () => allConditions().length;

  const findCondition = (group: FilterGroup, id: string): FilterCondition | undefined => group.conditions.find((condition) => condition.id === id) ?? group.groups.map((child) => findCondition(child, id)).find(Boolean);

  const updateCondition = (id: string, update: (condition: FilterCondition) => FilterCondition) => {
    const updateGroup = (group: FilterGroup): FilterGroup => ({ ...group, conditions: group.conditions.map((condition) => condition.id === id ? update(condition) : condition), groups: group.groups.map(updateGroup) });
    setTree(updateGroup(tree()));
  };
  const addCondition = (groupId: string) => {
    const id = `condition-${nextId++}`;
    const updateGroup = (group: FilterGroup): FilterGroup => group.id === groupId ? { ...group, conditions: [...group.conditions, defaultFilterCondition(id)] } : { ...group, groups: group.groups.map(updateGroup) };
    setTree(updateGroup(tree()));
  };
  const removeCondition = (groupId: string, conditionId: string) => {
    const updateGroup = (group: FilterGroup): FilterGroup => group.id === groupId ? { ...group, conditions: group.conditions.filter((condition) => condition.id !== conditionId) } : { ...group, groups: group.groups.map(updateGroup) };
    setTree(updateGroup(tree()));
  };
  /** Un solo nivel de anidamiento: si ya hay un subgrupo, no se agrega otro. */
  const addGroup = () => {
    if (tree().groups.length) return;
    const id = `group-${nextId++}`;
    setTree((group) => ({ ...group, groups: [...group.groups, { id, join: "and", conditions: [defaultFilterCondition(`condition-${nextId++}`)], groups: [] }] }));
  };
  const toggleConditionJoin = (conditionId: string) => {
    const updateGroup = (group: FilterGroup): FilterGroup => ({ ...group, conditions: group.conditions.map((condition) => condition.id === conditionId ? { ...condition, join: condition.join === "and" ? "or" : "and" } : condition), groups: group.groups.map(updateGroup) });
    setTree(updateGroup(tree()));
  };
  const toggleGroupJoin = (groupId: string) => {
    const updateGroup = (group: FilterGroup): FilterGroup => group.id === groupId ? { ...group, join: group.join === "and" ? "or" : "and" } : { ...group, groups: group.groups.map(updateGroup) };
    setTree(updateGroup(tree()));
  };
  const clearAll = () => setTree((group) => ({ ...group, conditions: [], groups: [] }));
  const removeGroup = (groupId: string) => setTree((root) => ({ ...root, groups: root.groups.filter((item) => item.id !== groupId) }));

  /**
   * `fieldFor` confía en que el campo existe: `FilterCondition.field` es una unión cerrada y el único
   * lugar que la escribe es el menú de campos, que ofrece exactamente esa unión.
   */
  const fieldFor = (condition: FilterCondition) => filterFields().find((field) => field.id === condition.field)!;
  const selectedValues = (condition: FilterCondition) => fieldFor(condition).options.filter((option) => condition.values.includes(option.value));

  // ── Menú de opciones de una fila ───────────────────────────────────────────────────────────
  const menuCondition = () => menuState() ? findCondition(tree(), menuState()!.rowId) : undefined;

  const openPicker = (event: MouseEvent, rowId: string, kind: FilterMenuKind) => {
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const width = kind === "value" ? 220 : kind === "field" ? 176 : 156;
    setMenuPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 4 });
    setMenuState({ rowId, kind });
    setMenuSnapshot(null);
    setMenuOpen(true);
  };

  const menuOptions = (): FilterOption[] => {
    const state = menuState();
    const condition = menuCondition();
    if (!state || !condition) return [];
    if (state.kind === "field") return filterFields().map((field) => ({ value: field.id, label: field.label }));
    if (state.kind === "operator") return fieldFor(condition).operators.map((operator) => ({ value: operator.value, label: operator.label }));
    return fieldFor(condition).options;
  };
  const menuSelected = (option: FilterOption) => {
    const state = menuState();
    const condition = menuCondition();
    if (!state || !condition) return false;
    if (state.kind === "field") return condition.field === option.value;
    if (state.kind === "operator") return condition.operator === option.value;
    return condition.values.includes(option.value);
  };
  const chooseOption = (option: FilterOption) => {
    const state = menuState();
    const condition = menuCondition();
    if (!state || !condition) return;
    if (state.kind === "field") {
      const nextField = filterFields().find((field) => field.id === option.value)!;
      closeOptionMenu();
      updateCondition(condition.id, (current) => ({ ...current, field: nextField.id as FilterField, operator: nextField.operators[0].value, values: nextField.options.length ? [nextField.options[0].value] : [] }));
    } else if (state.kind === "operator") {
      const operator = fieldFor(condition).operators.find((item) => item.value === option.value)!;
      closeOptionMenu();
      updateCondition(condition.id, (current) => ({ ...current, operator: operator.value, values: operator.multiple ? current.values : current.values.slice(0, 1) }));
    } else {
      const multiple = fieldFor(condition).operators.find((operator) => operator.value === condition.operator)?.multiple;
      if (!multiple) closeOptionMenu();
      updateCondition(condition.id, (current) => ({ ...current, values: multiple ? (current.values.includes(option.value) ? current.values.filter((value) => value !== option.value) : [...current.values, option.value]) : [option.value] }));
    }
  };
  const closeOptionMenu = () => {
    if (menuOpen()) {
      const state = menuState();
      if (state) setMenuSnapshot({ kind: state.kind, options: menuOptions(), selected: menuOptions().filter(menuSelected).map((option) => option.value) });
    }
    setMenuOpen(false);
  };

  // Cerrado, el menú sigue leyendo el snapshot para poder animar la salida.
  const renderedMenuOptions = () => menuOpen() ? menuOptions() : menuSnapshot()?.options ?? menuOptions();
  const renderedMenuSelected = (option: FilterOption) => menuOpen() ? menuSelected(option) : !!menuSnapshot()?.selected.includes(option.value);
  const renderedMenuKind = () => menuOpen() ? menuState()?.kind : menuSnapshot()?.kind ?? menuState()?.kind;

  // ── Panel ──────────────────────────────────────────────────────────────────────────────────
  const updatePanelPosition = () => {
    if (!panelTrigger) return;
    const rect = panelTrigger.getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 24);
    setPanelPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: rect.bottom + 8 });
  };

  /** El trigger del panel se registra al montar, para poder medirlo antes de posicionar. */
  const registerPanelTrigger = (element: HTMLButtonElement) => {
    panelTrigger = element;
  };

  /**
   * `repositionPanel` es lo que llama el `onClick` del trigger después de abrir: el panel hereda el
   * ancho del trigger recién cuando ya está en el DOM.
   */
  const repositionPanel = () => updatePanelPosition();

  /** Cerrar el panel cierra también el menú de opciones: nunca puede quedar huérfano. */
  const close = (restoreFocus = false) => {
    options.setOpen(false);
    if (restoreFocus) panelTrigger?.focus();
  };

  // El panel se puede cerrar desde afuera (otro menú se abrió, click afuera, Escape), así que el
  // menú de opciones se cierra por efecto y no dentro de `close()`. Así hay un solo camino.
  createEffect(() => {
    if (!options.isOpen()) closeOptionMenu();
  });

  const toggle = (event: MouseEvent) => {
    if (options.isOpen()) {
      close();
      return;
    }
    panelTrigger = event.currentTarget as HTMLButtonElement;
    options.setOpen(true);
  };

  onMount(() => {
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menuOpen() && !target.closest("[data-filter-option-menu]") && !target.closest("[data-filter-picker]")) closeOptionMenu();
      if (options.isOpen() && !target.closest('[data-testid="task-filter-panel"]') && !target.closest('[data-testid="tasks-controls"]') && !target.closest("[data-filter-option-menu]")) close();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // El menú de opciones primero: está encima del panel y es lo que el usuario ve más arriba.
      if (menuOpen()) {
        closeOptionMenu();
        return;
      }
      if (options.isOpen()) close(true);
    };
    const reposition = () => {
      if (options.isOpen()) updatePanelPosition();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", reposition);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", reposition);
    });
  });

  return {
    // árbol
    tree, conditionCount, fieldFor, selectedValues, addCondition, removeCondition, addGroup,
    updateCondition, toggleConditionJoin, toggleGroupJoin, clearAll, removeGroup,
    // menú de opciones
    menuOpen, menuPosition, openPicker, chooseOption, closeOptionMenu,
    renderedMenuOptions, renderedMenuSelected, renderedMenuKind,
    // panel
    close, toggle, panelPosition, registerPanelTrigger, repositionPanel,
  };
}
