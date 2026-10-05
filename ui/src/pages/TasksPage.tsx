/**
 * Tasks: toolbar + board.
 *
 * Es un contenedor: lee el estado del board en un scope reactivo —que es la URL, vía
 * `useTasksUrl()`— **aplica el árbol de filtros** y lo baja como valores planos, para que
 * `TasksToolbar` y `TaskBoardContainer` sigan siendo componentes con props y se puedan montar en
 * una story sin provider ni router.
 *
 * La página coloca la toolbar en la cabecera compartida y el board en la columna común del PageFrame.
 */
import { useNavigate } from "@solidjs/router";
import { createMemo } from "solid-js";
import { filterTasks, gates as allGates, TaskBoardContainer, tasks as allTasks, TasksToolbar, useTasksUrl } from "../modules/tasks";
import type { Task } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

export function TasksPage() {
  const board = useTasksUrl();
  const navigate = useNavigate();

  const filteredTasks = createMemo(() => filterTasks(allTasks, board.filterTree()));
  const filteredGates = createMemo(() => filterTasks(allGates, board.filterTree()));
  const scopeCounts = createMemo(() => {
    const tasks = filteredTasks();
    const gates = filteredGates();
    const closed = tasks.filter((task) => task.status === "done" || task.status === "canceled").length;
    return { active: tasks.length - closed + gates.length, closed, all: tasks.length + gates.length };
  });
  const visibleTasks = createMemo(() => {
    const tasks = filteredTasks();
    if (board.scope() === "closed") return tasks.filter((task) => task.status === "done" || task.status === "canceled");
    if (board.scope() === "all") return tasks;
    return tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  });
  const visibleGates = createMemo(() => board.scope() === "closed" ? [] : filteredGates());

  /**
   * Abrir una tarea es navegar a `/tasks/<id>`.
   *
   * La navegación vive acá y no en la fila: los componentes del board son presentacionales y las
   * stories los montan sin router, así que un `useNavigate()` adentro de `TaskListRow` los rompería.
   */
  const openTask = (task: Task) => navigate(`/tasks/${task.id}`);

  return (
    <PageFrame header={<TasksToolbar view={board.view()} onView={board.setView} scope={board.scope()} scopeCounts={scopeCounts()} onScope={board.setScope} sort={board.sort()} onSort={board.setSort} group={board.group()} onGroup={board.setGroup} filterTree={board.filterTree()} onFilterTree={board.setFilterTree} />}>
      <div class="tasks-content">
        <TaskBoardContainer tasks={visibleTasks()} gates={visibleGates()} view={board.view()} sort={board.sort()} group={board.group()} onOpenTask={openTask} />
      </div>
    </PageFrame>
  );
}
