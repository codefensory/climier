import { projectBoard, projectTaskDetail } from "./climier/projection";
import { snapshot } from "./source";
import type { Task, TaskDetail } from "../types";

/**
 * Fuente de datos del board.
 *
 * Hoy es `data/snapshot.ts` (un snapshot de ejemplo con la forma real del server de climier). En
 * cuanto exista el fetch, este archivo es el **único** que cambia: el resto del módulo consume
 * `tasks`, `gates`, `taskById` y `taskDetailById`, que son estables.
 */
const board = projectBoard(snapshot);

/** Todas las tasks, incluidos `done`, `canceled` y `archived`. */
export const tasks: Task[] = board.tasks;

/** Sólo las gates pendientes (`open`), que son las que se muestran en el board. */
export const gates: Task[] = board.gates;

/** Una task o gate por id, o `undefined` si la URL apunta a algo que no existe. */
export function taskById(id: string): Task | undefined {
  return tasks.find((task) => task.id === id) ?? gates.find((gate) => gate.id === id);
}

/** Detalle completo derivado del snapshot, o `undefined` si el id no existe. */
export function taskDetailById(id: string): TaskDetail | undefined {
  return projectTaskDetail(snapshot, id);
}

export { snapshot };
