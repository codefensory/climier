import { taskDetailFor } from "./taskDetail";
import { TASK_STATUSES } from "./statuses";
import type { FilterCondition, FilterGroup, Task, TaskDetail, TaskStatus } from "../types";

/**
 * Todos los estados, **derivados** de `TASK_STATUSES` en vez de repetir la lista a mano.
 */
export const ALL_STATUSES = TASK_STATUSES;

/**
 * Task base para stories: se sobreescribe sólo lo que el caso necesita.
 *
 * Es una **función** y no un objeto compartido a propósito. Con un objeto único, dos stories que lo
 * mutaran se pisarían entre sí y el orden de visita cambiaría el resultado.
 */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-checkout-empty-states",
    kind: "task",
    title: "Audit the checkout empty states",
    description: "Map the empty, error and recovery moments across checkout.",
    status: "ready",
    tags: ["design"],
    notes: 2,
    refs: 1,
    blockers: 0,
    dependents: 3,
    updatedAt: "2026-10-03T07:00:00.000Z",
    progress: 0,
    initiative: "checkout",
    domain: "commerce",
    claimedBy: null,
    claimStale: false,
    revision: 4,
    backlog: false,
    ...overrides,
  };
}

/** Gate abierta para stories. */
export function makeGate(overrides: Partial<Task> = {}): Task {
  return makeTask({
    id: "G-checkout-tax-decision",
    kind: "gate",
    title: "Decide the tax display rule for recovered carts",
    description: "Blocks the coupon audit until the rule is fixed.",
    status: "open",
    tags: ["checkout"],
    notes: 0,
    refs: 0,
    dependents: 1,
    updatedAt: "2026-10-02T18:00:00.000Z",
    progress: 0,
    purpose: "decision",
    ...overrides,
  });
}

/**
 * Título largo real, sin trucos: sirve para ver el `truncate` de la fila y el `line-clamp-2` de la
 * tarjeta. Un título corto nunca revela si el truncado funciona.
 */
export const LONG_TITLE = "Rework the checkout recovery flow so partially failed payments keep the original cart, preserve the applied coupon and explain in one sentence what the customer should do next";

/** Descripción larga, para el mismo motivo. */
export const LONG_DESCRIPTION = "When a payment fails halfway the customer currently loses the cart, the coupon and any address they had already confirmed. Rebuild the recovery path so that every one of those survives, and make the failure explain itself without sending the customer to support.";

/** Un tag que no está en la paleta curada. Antes de `taskTag()` esto tiraba la vista abajo. */
export const UNKNOWN_TAG = "research";

/** Una condición de filtro con valores razonables; se sobreescribe lo que cada caso necesita. */
export function makeCondition(id: string, over: Partial<FilterCondition> = {}): FilterCondition {
  return { id, join: "and", field: "status", operator: "is", values: ["blocked"], ...over };
}

/** Árbol de filtros vacío, o con lo que se le pase. */
export function makeFilterTree(over: Partial<FilterGroup> = {}): FilterGroup {
  return { id: "group-root", join: "and", conditions: [], groups: [], ...over };
}

/**
 * Detalle para stories: parte del derivado base y permite pisar cualquier campo.
 *
 * Igual que `makeTask`, es una **función**: un objeto compartido que una story mutara se vería en la
 * siguiente.
 */
export function makeTaskDetail(over: Partial<TaskDetail> = {}, taskOver: Partial<Task> = {}): TaskDetail {
  return { ...taskDetailFor(makeTask(taskOver)), ...over };
}

/** Estados de task para barrer en stories. */
export type { TaskStatus };
