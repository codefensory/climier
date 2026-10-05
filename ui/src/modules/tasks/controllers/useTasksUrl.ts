import { useSearchParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import { groupFields, sortFields } from "../data/sorting";
import { decodeFilterTree, encodeFilterTree } from "../utils/filterTreeParam";
import type { FilterGroup, TaskGroupBy, TaskScope, TaskSort, TaskSortKey, TaskView } from "../types";

/**
 * Estado de presentación del board (vista, alcance, orden, agrupación y filtros) **en la URL**.
 *
 * Reemplaza a `TasksBoardProvider`: la URL es la fuente de verdad, así que no hay nada que sincronizar y
 * los cinco parámetros se comportan igual — a diferencia de antes, que vista/orden/grupo vivían en un
 * provider por encima del switch de vistas y sobrevivían a navegar, mientras el árbol de filtros vivía
 * dentro de `TasksToolbar` y se perdía. Esa asimetría era el hallazgo de la Fase 5 y esto la cierra.
 *
 * ### Consecuencia que hay que decir en voz alta
 *
 * Ahora **ninguno de los cinco sobrevive** a irse a otra vista y volver: `Home` es `/` y `Tasks` es
 * `/tasks`, así que el estado del board se queda en `/tasks` con su URL. Es el mismo comportamiento que ya
 * tenía el filtro, extendido al estado completo del board: coherente, y una URL compartida siempre reproduce lo que se ve.
 * Si se quisiera que sobreviva, el cambio es que los links del sidebar lleven el search actual
 * (`navigate(path + location.search)`), y esa es una decisión de producto, no una limitación técnica.
 *
 * ### Los defaults no ensucian la URL
 *
 * `list`, `active`, `updated:desc` y `status` son los valores iniciales, así que no se escriben: `/tasks` ya
 * significa eso. Un `null` en el setter es lo que `useSearchParams` interpreta como "sacá esta clave".
 *
 * ### `replace` y no `push`
 *
 * Cambiar un filtro no es navegar. Con `push`, el botón de atrás dejaría de salir del board y pasaría a ser
 * un deshacer de cada click (abrir el menú, elegir un campo, elegir un valor). Los clicks del sidebar sí
 * empujan, porque eso sí es navegación.
 *
 * ### Los cuatro son `createMemo`
 *
 * Porque devuelven objetos y arrays nuevos en cada lectura. Sin memo, cada lectura del árbol daría objetos
 * distintos y el `<For>` de las condiciones recrearía las filas en cada acceso — y el árbol se lee muchas
 * veces por render (el contador del badge, el panel, los conectores).
 */
export function useTasksUrl() {
  const [query, setSearchParams] = useSearchParams();

  /** Sólo se trabaja con params de una sola aparición (`?view=a&view=b` se ignora). */
  const one = (param: string | string[] | undefined) => (typeof param === "string" ? param : undefined);

  const view = (): TaskView => (one(query.view) === "kanban" ? "kanban" : "list");
  const scope = createMemo<TaskScope>(() => decodeScope(one(query.scope)));
  const sort = createMemo<TaskSort>(() => decodeSort(one(query.sort)));
  const group = createMemo<TaskGroupBy>(() => decodeGroup(one(query.group)));
  const filterTree = createMemo<FilterGroup>(() => decodeFilterTree(one(query.filter)));

  const setView = (next: TaskView) => setSearchParams({ view: next === "list" ? null : next }, { replace: true });

  const setScope = (next: TaskScope) => setSearchParams({ scope: next === "active" ? null : next }, { replace: true });

  const setSort = (next: TaskSort) => setSearchParams({ sort: next.key === "updated" && next.dir === "desc" ? null : `${next.key}:${next.dir}` }, { replace: true });

  const setGroup = (next: TaskGroupBy) => setSearchParams({ group: next === "status" ? null : next }, { replace: true });

  /**
   * Acepta también la forma de updater porque es la que usa `useTaskFilters` en cada edición
   * (`setTree(prev => …)`): así el controlador del panel no tiene que saber que hay una URL abajo.
   */
  const setFilterTree = (next: FilterGroup | ((previous: FilterGroup) => FilterGroup)) => {
    const value = typeof next === "function" ? next(filterTree()) : next;
    setSearchParams({ filter: encodeFilterTree(value) ?? null }, { replace: true });
  };

  return { view, setView, scope, setScope, sort, setSort, group, setGroup, filterTree, setFilterTree };
}

export type TasksUrl = ReturnType<typeof useTasksUrl>;

export const DEFAULT_TASK_SORT: TaskSort = { key: "updated", dir: "desc" };

function decodeSort(raw: string | undefined): TaskSort {
  if (!raw) return { ...DEFAULT_TASK_SORT };
  const [key, dir] = raw.split(":");
  if (!sortFields.some((field) => field.key === key)) return { ...DEFAULT_TASK_SORT };
  return { key: key as TaskSortKey, dir: dir === "asc" ? "asc" : "desc" };
}

function decodeScope(raw: string | undefined): TaskScope {
  return raw === "closed" || raw === "all" ? raw : "active";
}

function decodeGroup(raw: string | undefined): TaskGroupBy {
  return groupFields.some((field) => field.key === raw) ? (raw as TaskGroupBy) : "status";
}
