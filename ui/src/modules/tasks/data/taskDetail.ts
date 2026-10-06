import type { Task, TaskDetail } from "../types";

/** Autor local del comentario que se escribe en la página (no hay directorio de usuarios). */
export const localAuthor = "you";

/**
 * Detalle sintético a partir de un `Task` **para stories y fixtures**.
 *
 * El detalle real lo proyecta `data/climier/projection.ts` desde el snapshot
 * (`taskDetailById`). Este builder existe para que una story de `TaskDetailView` pueda montar un
 * detalle sin arrastrar el snapshot entero: parte de la task y deja el resto vacío para que los
 * `args` lo sobreescriban.
 */
export function taskDetailFor(task: Task): TaskDetail {
  return {
    task,
    body: task.description ? [task.description] : [],
    acceptance: null,
    initiative: task.initiative,
    domain: task.domain,
    claimedBy: task.claimedBy,
    blockers: [],
    dependents: [],
    knowledge: [],
    refs: [],
    activity: [],
  };
}
