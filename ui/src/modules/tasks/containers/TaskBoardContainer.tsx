import { Show } from "solid-js";
import { BREAKPOINTS, useMediaQuery } from "../../core";
import { TaskKanbanView } from "../components/TaskKanbanView";
import { TaskListView } from "../components/TaskListView";
import type { Task, TaskGroupBy, TaskSort, TaskView } from "../types";

export type TaskBoardContainerProps = {
  /** Tasks ya filtradas por la página. */
  tasks: Task[];
  /** Gates abiertas, también filtradas. */
  gates?: Task[];
  view: TaskView;
  sort: TaskSort;
  group: TaskGroupBy;
  /** Abre una tarea. La página es la que navega; el contenedor no conoce el router. */
  onOpenTask?: (task: Task) => void;
};

/**
 * Elige entre lista y kanban, y lee el ancho de pantalla.
 *
 * Recibe las tasks por prop (antes leía el fixture del módulo): eso es lo que permite que la página
 * aplique el árbol de filtros **antes** de elegir la vista.
 *
 * La regla es que la lista necesita ancho para mostrar los metadatos al costado; cuando no entra, se
 * pasa a kanban sin preguntar. No es una preferencia del usuario, es una adaptación: por eso el
 * switch sigue mostrando "List" activo aunque se esté viendo el kanban.
 */
export function TaskBoardContainer(props: TaskBoardContainerProps) {
  const isNarrow = useMediaQuery(BREAKPOINTS.narrow);
  return (
    <section aria-label="Tasks">
      <Show when={!isNarrow() && props.view === "list"} fallback={<TaskKanbanView tasks={props.tasks} gates={props.gates} sort={props.sort} group={props.group} onOpenTask={props.onOpenTask} />}>
        <TaskListView tasks={props.tasks} gates={props.gates} sort={props.sort} group={props.group} onOpenTask={props.onOpenTask} />
      </Show>
    </section>
  );
}
