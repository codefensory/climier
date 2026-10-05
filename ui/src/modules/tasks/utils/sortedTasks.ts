import { statusOrder } from "../data/statuses";
import type { Task, TaskSort, TaskStatus } from "../types";

/**
 * Ordena sin mutar. El `index` original se usa como desempate para que el orden sea **estable**:
 * dos tareas con el mismo valor conservan el orden de entrada, sin el `sort` inestable de V8.
 *
 * El índice de status sale de los datos (`statusOrder`) y no de un `if` por valor; un status fuera
 * de la tabla (canceled, archived) cae al final.
 */
export function sortedTasks(items: Task[], sort: TaskSort) {
  const direction = sort.dir === "asc" ? 1 : -1;
  const statusIndex = new Map<TaskStatus, number>(statusOrder.map((group, index) => [group.status, index] as [TaskStatus, number]));
  return items.map((task, index) => ({ task, index })).sort((left, right) => {
    let comparison = 0;
    if (sort.key === "updated") comparison = left.task.updatedAt.localeCompare(right.task.updatedAt);
    else if (sort.key === "title") comparison = left.task.title.toLowerCase().localeCompare(right.task.title.toLowerCase());
    else if (sort.key === "id") comparison = left.task.id.localeCompare(right.task.id);
    else if (sort.key === "initiative") comparison = (left.task.initiative ?? "").localeCompare(right.task.initiative ?? "");
    else comparison = (statusIndex.get(left.task.status as TaskStatus) ?? 99) - (statusIndex.get(right.task.status as TaskStatus) ?? 99);
    return comparison === 0 ? left.index - right.index : comparison * direction;
  }).map(({ task }) => task);
}
