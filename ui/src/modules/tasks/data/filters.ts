import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import { boardTags, claimedAgents } from "./climier/projection";
import { snapshot } from "./source";
import { statusOrder } from "./statuses";
import type { BoardStatus, FilterCondition, FilterFieldDef, FilterGroup, FilterOption } from "../types";

/** Los mismos operadores para todos los campos de valor simple. */
const TEXT_OPERATORS = [
  { value: "is", label: "is" },
  { value: "is-not", label: "is not" },
  { value: "any", label: "is any of", multiple: true },
  { value: "none", label: "is none of", multiple: true },
];

const statusOptions: FilterOption[] = [
  ...statusOrder.map(({ status, label }) => ({ value: status, label, status: status as BoardStatus })),
  { value: "canceled", label: "Canceled", status: "canceled" },
  { value: "archived", label: "Archived", status: "archived" },
];

const claimOptions: FilterOption[] = [
  { value: "Unassigned", label: "Unassigned" },
  ...claimedAgents(snapshot).map((agent) => ({ value: agent, label: agent })),
];

const tagOptions: FilterOption[] = boardTags(snapshot).map((tag) => ({ value: tag, label: tag, chip: true }));

const initiativeOptions: FilterOption[] = Object.keys(snapshot.initiatives)
  .sort()
  .map((initiative) => ({ value: initiative, label: initiative }));

/**
 * Los campos filtrables con sus operadores y opciones.
 *
 * Es una **función** y no una constante porque las opciones salen del vocabulario del snapshot
 * (agentes con claim, tags e initiatives presentes). Con la lista hardcodeada, un filtro por una
 * initiative nueva no tendría opción.
 */
export function filterFields(): FilterFieldDef[] {
  return [
    { id: "status", label: "Status", icon: Task01Icon, operators: TEXT_OPERATORS, options: statusOptions },
    { id: "claimed", label: "Claimed", icon: UserIcon, operators: TEXT_OPERATORS, options: claimOptions },
    { id: "tags", label: "Tags", icon: BookOpen01Icon, operators: [...TEXT_OPERATORS.slice(0, 2), { value: "any", label: "is any of", multiple: true }, { value: "none", label: "is none of", multiple: true }], options: tagOptions },
    { id: "initiative", label: "Initiative", icon: Rocket01Icon, operators: TEXT_OPERATORS, options: initiativeOptions },
  ];
}

/** Condición inicial de una fila nueva: primer campo, primer operador, primer valor. */
export function defaultFilterCondition(id: string): FilterCondition {
  return { id, join: "and", field: "status", operator: "is", values: [statusOptions[0].value] };
}

/**
 * Árbol de filtros vacío.
 *
 * Existe como función y no como constante compartida porque cada uso necesita un objeto propio.
 */
export function emptyFilterTree(): FilterGroup {
  return { id: "group-root", join: "and", conditions: [], groups: [] };
}
