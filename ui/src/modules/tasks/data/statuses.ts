import type { BoardStatus, TaskStatus, TaskStatusOption } from "../types";

/**
 * Token de color de cada estado: la **única** fuente.
 *
 * Los valores vienen del vocabulario de climier (`in_progress`, `backlog`, `open`, …), no de un
 * alias de la UI. `ready`, `submitted`, `blocked` y `done` reutilizan tokens existentes a propósito.
 */
export const STATUS_TOKENS: Record<BoardStatus, string> = {
  backlog: "var(--color-status-backlog)",
  ready: "var(--color-faint)",
  in_progress: "var(--color-status-progress)",
  submitted: "var(--color-tone-blue-ink)",
  blocked: "var(--color-tone-mauve-ink)",
  done: "var(--color-tone-green-ink)",
  canceled: "var(--color-faint)",
  archived: "var(--color-faint)",
  open: "var(--color-tone-amber-ink)",
  resolved: "var(--color-tone-green-ink)",
  superseded: "var(--color-faint)",
};

/** Rótulo visible de cada estado. La tabla cubre tasks y gates en un solo lugar. */
const STATUS_LABELS: Record<BoardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  submitted: "Submitted",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
  archived: "Archived",
  open: "Open",
  resolved: "Resolved",
  superseded: "Superseded",
};

/**
 * Columnas del board de tasks, en orden de flujo de trabajo.
 *
 * Los estados históricos (`canceled`, `archived`) **no** ocupan columna fija: si aparecen en los
 * datos, `taskGroups()` agrega un grupo al final. Así el board queda limpio cuando no hay historial
 * y completo cuando lo hay.
 */
export const statusOrder: TaskStatusOption[] = [
  { status: "ready", label: STATUS_LABELS.ready, color: STATUS_TOKENS.ready },
  { status: "in_progress", label: STATUS_LABELS.in_progress, color: STATUS_TOKENS.in_progress },
  { status: "submitted", label: STATUS_LABELS.submitted, color: STATUS_TOKENS.submitted },
  { status: "blocked", label: STATUS_LABELS.blocked, color: STATUS_TOKENS.blocked },
  { status: "backlog", label: STATUS_LABELS.backlog, color: STATUS_TOKENS.backlog },
  { status: "done", label: STATUS_LABELS.done, color: STATUS_TOKENS.done },
];

/** Rótulo de un estado, con fallback al valor crudo para no renderizar `undefined`. */
export function statusLabel(status: BoardStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** Todos los estados de task, para `ALL_STATUSES` de las stories. */
export const TASK_STATUSES: TaskStatus[] = ["backlog", "ready", "in_progress", "submitted", "blocked", "done", "canceled", "archived"];
