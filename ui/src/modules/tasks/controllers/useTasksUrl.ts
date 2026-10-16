import { useSearchParams } from "@solidjs/router";
import { createMemo, createSignal } from "solid-js";
import type { StorageLike } from "../../core";
import { groupFields, sortFields } from "../data/sorting";
import type { ClimierSnapshot } from "../data/climier/contract";
import { decodeFilterTree, encodeFilterTree } from "../utils/filterTreeParam";
import type { FilterGroup, TaskGroupBy, TaskScope, TaskSort, TaskSortKey, TaskView } from "../types";

/**
 * Estado de presentación del board: la **vista** es una preferencia del navegador, el resto (alcance,
 * orden, agrupación y filtros) vive en la URL.
 *
 * La vista se cambia sin navegar: no escribe ningún search param, así que atrás/adelante no la pisan y
 * volver a Tasks la conserva. Los otros cuatro describen una consulta concreta sobre los datos —una URL
 * compartida tiene que poder reproducirla— y por eso siguen en la URL, con los defaults (`active`,
 * `updated:desc`, `status`) sin escribir y `replace: true`, porque cambiar un filtro no es navegar.
 *
 * El costo de tenerla en `localStorage`: una URL vieja con `?view=kanban` queda inerte. Leerla como semilla
 * habría dejado dos fuentes para el mismo valor, y el atrás —que restaura una URL sin el param— volvería a
 * decidir la vista, que es exactamente lo que se está sacando.
 *
 * ### Los cuatro de la URL son `createMemo`
 *
 * Porque devuelven objetos y arrays nuevos en cada lectura. Sin memo, cada lectura del árbol daría objetos
 * distintos y el `<For>` de las condiciones recrearía las filas en cada acceso — y el árbol se lee muchas
 * veces por render (el contador del badge, el panel, los conectores).
 */
export function useTasksUrl(snapshot: () => ClimierSnapshot) {
  const [query, setSearchParams] = useSearchParams();

  /** Sólo se trabaja con params de una sola aparición (`?scope=a&scope=b` se ignora). */
  const one = (param: string | string[] | undefined) => (typeof param === "string" ? param : undefined);

  const [view, setViewSignal] = createSignal<TaskView>(readStoredView());
  const scope = createMemo<TaskScope>(() => decodeScope(one(query.scope)));
  const sort = createMemo<TaskSort>(() => decodeSort(one(query.sort)));
  const group = createMemo<TaskGroupBy>(() => decodeGroup(one(query.group)));
  const filterTree = createMemo<FilterGroup>(() => decodeFilterTree(one(query.filter), snapshot()));

  const setView = (next: TaskView) => {
    setViewSignal(next);
    try {
      browserStorage()?.setItem(TASKS_VIEW_STORAGE_KEY, next);
    } catch {
      // Un storage bloqueado no puede impedir cambiar la vista en esta sesión.
    }
  };

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

export const TASKS_VIEW_STORAGE_KEY = "climier-ui:tasks-view";

export const DEFAULT_TASK_SORT: TaskSort = { key: "updated", dir: "desc" };

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Sin preferencia guardada (o con storage bloqueado) la vista es la lista, que es el default del board. */
function readStoredView(): TaskView {
  try {
    return browserStorage()?.getItem(TASKS_VIEW_STORAGE_KEY) === "kanban" ? "kanban" : "list";
  } catch {
    return "list";
  }
}

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
