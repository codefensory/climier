import { emptyFilterTree, filterFields } from "../data/filters";
import type { FilterCondition, FilterField, FilterGroup, FilterJoin } from "../types";

/**
 * Serialización del árbol de filtros a un search param, y de vuelta.
 *
 * ### Por qué JSON y no un formato lindo
 *
 * Porque los valores son texto libre: un label se llama `bug fix`, otro puede tener una coma. Un formato
 * legible tipo `status.is.urgent,labels.has.bug` necesita reglas de escape, y una regla de escape mal escrita
 * es un bug que sólo aparece con el valor raro. JSON percent-encoded se lee bastante peor en la barra de
 * direcciones, pero no tiene casos raros. Si algún día estas URLs son documentos que la gente comparte a
 * mano, ahí sí vale la pena el formato lindo, con sus tests de escape.
 *
 * ### Qué NO viaja en la URL
 *
 * Los `id` de cada condición y grupo. Son identificadores internos (claves de lista, `findCondition`) y no
 * significan nada para quien lee la URL. Se regeneran al decodificar con el prefijo `url-`, distinto del
 * `condition-N` / `group-N` que genera el contador de `useTaskFilters` para las filas nuevas: así una fila
 * agregada después de cargar un link no puede chocar con una que vino en el link.
 *
 * ### Lo que llega en la URL es entrada de usuario
 *
 * Cualquiera puede escribir `#/tasks?filter=basura`, así que el decodificador **valida**: campo y operador
 * tienen que existir en `filterFields` (si no, `fieldFor()` explotaría al renderizar) y una condición
 * inválida se descarta sola. Un JSON roto devuelve el árbol vacío en vez de tirar.
 */
type WireCondition = { f: FilterField; o: string; v: string[]; j?: FilterJoin };
type WireGroup = { j?: FilterJoin; c: WireCondition[]; g: WireGroup[] };

const isJoin = (value: unknown): value is FilterJoin => value === "and" || value === "or";
const isField = (value: unknown): value is FilterField => filterFields().some((field) => field.id === value);
const operatorsOf = (field: FilterField) => filterFields().find((item) => item.id === field)!.operators.map((operator) => operator.value);

/** Sólo se escribe lo que no es el default: `join: "and"` es la ausencia de la clave. */
function toWire(group: FilterGroup): WireGroup {
  return {
    ...(group.join === "or" ? { j: group.join } : {}),
    c: group.conditions.map((condition) => ({
      f: condition.field,
      o: condition.operator,
      v: [...condition.values],
      ...(condition.join === "or" ? { j: condition.join } : {}),
    })),
    g: group.groups.map(toWire),
  };
}

/** Un árbol sin condiciones ni grupos no ocupa lugar en la URL. */
export function encodeFilterTree(tree: FilterGroup): string | undefined {
  if (!tree.conditions.length && !tree.groups.length) return undefined;
  return JSON.stringify(toWire(tree));
}

export function decodeFilterTree(param: string | undefined): FilterGroup {
  if (!param) return emptyFilterTree();

  let wire: unknown;
  try {
    wire = JSON.parse(param);
  } catch {
    return emptyFilterTree();
  }

  let counter = 0;
  const nextId = () => `url-${++counter}`;

  const readCondition = (raw: unknown): FilterCondition | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const { f, o, v, j } = raw as Partial<WireCondition>;
    if (!isField(f)) return undefined;
    if (typeof o !== "string" || !operatorsOf(f).includes(o)) return undefined;
    return {
      id: nextId(),
      join: isJoin(j) ? j : "and",
      field: f,
      operator: o,
      values: Array.isArray(v) ? v.filter((value): value is string => typeof value === "string") : [],
    };
  };

  const readGroup = (raw: unknown, id: string): FilterGroup => {
    if (!raw || typeof raw !== "object") return { id, join: "and", conditions: [], groups: [] };
    const { j, c, g } = raw as Partial<WireGroup>;
    return {
      id,
      join: isJoin(j) ? j : "and",
      conditions: (Array.isArray(c) ? c : []).map(readCondition).filter((condition): condition is FilterCondition => Boolean(condition)),
      groups: (Array.isArray(g) ? g : []).map((child) => readGroup(child, nextId())),
    };
  };

  return readGroup(wire, "group-root");
}
