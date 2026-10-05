import type { FilterCondition, FilterGroup, Task } from "../types";

/**
 * Aplica el árbol de filtros al board.
 *
 * Hasta ahora el panel de filtros escribía la URL pero **nadie leía el árbol para filtrar**: el
 * board mostraba siempre todas las tasks. Esto cierra ese hueco y es lo que hace que el link desde
 * `/initiatives` ("ver las tasks de esta iniciativa") realmente filtre.
 *
 * La semántica es la del panel: cada fila evalúa `field operator values`; las filas de un grupo se
 * combinan con `and`/`or` y los subgrupos, con el join del grupo padre. Un árbol vacío no filtra.
 */

function hasTag(task: Task, tag: string): boolean {
  return task.tags.includes(tag);
}

function matchesCondition(task: Task, condition: FilterCondition): boolean {
  const [first] = condition.values;

  if (condition.field === "status") {
    if (condition.operator === "is") return task.status === first;
    if (condition.operator === "is-not") return task.status !== first;
    if (condition.operator === "any") return condition.values.includes(task.status);
    if (condition.operator === "none") return !condition.values.includes(task.status);
    return true;
  }

  if (condition.field === "claimed") {
    const value = task.claimedBy ?? "Unassigned";
    if (condition.operator === "is") return value === first;
    if (condition.operator === "is-not") return value !== first;
    if (condition.operator === "any") return condition.values.includes(value);
    if (condition.operator === "none") return !condition.values.includes(value);
    return true;
  }

  if (condition.field === "tags") {
    if (condition.operator === "is") return hasTag(task, first);
    if (condition.operator === "is-not") return !hasTag(task, first);
    if (condition.operator === "any") return condition.values.some((tag) => hasTag(task, tag));
    if (condition.operator === "none") return condition.values.every((tag) => !hasTag(task, tag));
    return true;
  }

  if (condition.field === "initiative") {
    const value = task.initiative ?? "";
    if (condition.operator === "is") return value === first;
    if (condition.operator === "is-not") return value !== first;
    if (condition.operator === "any") return condition.values.includes(value);
    if (condition.operator === "none") return !condition.values.includes(value);
    return true;
  }

  return true;
}

function matchesGroup(task: Task, group: FilterGroup): boolean {
  const conditionResults = group.conditions.map((condition) => matchesCondition(task, condition));
  const groupResults = group.groups.map((child) => matchesGroup(task, child));
  const results = [...conditionResults, ...groupResults];
  if (!results.length) return true;
  return group.join === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** ¿Hay algún filtro activo? Un árbol vacío no filtra. */
export function hasActiveFilters(tree: FilterGroup): boolean {
  return tree.conditions.length > 0 || tree.groups.length > 0;
}

/** Devuelve las tasks que pasan el árbol. Un árbol vacío devuelve la lista completa. */
export function filterTasks(items: Task[], tree: FilterGroup): Task[] {
  if (!hasActiveFilters(tree)) return items;
  return items.filter((task) => matchesGroup(task, tree));
}
