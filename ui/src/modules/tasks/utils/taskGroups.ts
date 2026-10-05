import { groupProgress } from "../data/climier/projection";
import { STATUS_TOKENS, statusLabel, statusOrder } from "../data/statuses";
import { taskTag } from "../data/tags";
import { sortedTasks } from "./sortedTasks";
import type { BoardStatus, Task, TaskGroupBy, TaskGroupView, TaskSort, TaskStatus } from "../types";

/**
 * Agrupa las tareas según el criterio elegido.
 *
 * Recibe las tareas por parámetro en vez de leer el fixture del módulo: así la app puede pasar
 * datos reales y las stories pueden pasar casos extremos.
 *
 * El glyph se devuelve como **discriminante** (`{ kind: "status", status }`) y no como JSX: un
 * elemento JSX en los datos se instancia una sola vez y no es reutilizable. El JSX lo arma
 * `GroupGlyph` en `GroupHeader`.
 *
 * El progreso de cada grupo lo calcula `groupProgress()` sobre el trabajo vigente (ver la
 * proyección): lo terminado cuenta y lo cancelado queda fuera.
 */
export function taskGroups(items: Task[], groupBy: TaskGroupBy, sort: TaskSort): TaskGroupView[] {
  if (groupBy === "status") {
    const groups: TaskGroupView[] = statusOrder.map((group) => ({
      ...group,
      key: group.status,
      glyph: { kind: "status", status: group.status },
      tasks: sortedTasks(items.filter((task) => task.status === group.status), sort),
      progress: groupProgress(items.filter((task) => task.status === group.status)),
    }));
    // Estados históricos (canceled, archived) sin columna fija: sólo si hay datos.
    const known = new Set(statusOrder.map((group) => group.status));
    const extra: TaskStatus[] = [...new Set(items.map((task) => task.status))]
      .filter((status): status is TaskStatus => !known.has(status as TaskStatus) && status !== "open" && status !== "resolved" && status !== "superseded")
      .sort();
    for (const status of extra) {
      const tasks = sortedTasks(items.filter((task) => task.status === status), sort);
      groups.push({ key: status, label: statusLabel(status), color: STATUS_TOKENS[status], status, glyph: { kind: "status", status }, tasks, progress: groupProgress(tasks) });
    }
    return groups;
  }

  if (groupBy === "tags") {
    return [...new Set(items.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)).map((tag) => ({
      key: tag,
      label: tag,
      color: taskTag(tag).color,
      identityChip: true,
      glyph: { kind: "tag", tag },
      tasks: sortedTasks(items.filter((task) => task.tags.includes(tag)), sort),
      progress: groupProgress(items.filter((task) => task.tags.includes(tag))),
    }));
  }

  if (groupBy === "initiative") {
    return [...new Set(items.map((task) => task.initiative ?? "none"))].sort((a, b) => a.localeCompare(b)).map((initiative) => ({
      key: initiative,
      label: initiative === "none" ? "No initiative" : initiative,
      color: "var(--color-tone-blue-ink)",
      glyph: { kind: "initiative", initiative },
      tasks: sortedTasks(items.filter((task) => (task.initiative ?? "none") === initiative), sort),
      progress: groupProgress(items.filter((task) => (task.initiative ?? "none") === initiative)),
    }));
  }

  return [{ key: "all", label: "All tasks", color: "var(--color-faint)", glyph: { kind: "all" }, tasks: sortedTasks(items, sort), progress: groupProgress(items) }];
}

/** Etiqueta legible de un `BoardStatus` para headers sueltos. */
export function boardStatusLabel(status: BoardStatus): string {
  return statusLabel(status);
}

/** Grupo de gates abiertas, que el board dibuja como una fila/sección aparte. */
export function gateGroup(gates: Task[]): TaskGroupView {
  return {
    key: "gates",
    label: "Open gates",
    color: "var(--color-tone-amber-ink)",
    glyph: { kind: "gate" },
    tasks: gates,
    progress: groupProgress(gates),
    hideProgress: true,
  };
}
