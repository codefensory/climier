import { For, Show } from "solid-js";
import { gateGroup, taskGroups } from "../utils/taskGroups";
import { GroupHeader } from "./GroupHeader";
import { KanbanCard } from "./KanbanCard";
import type { Task, TaskGroupBy, TaskSort } from "../types";

export type TaskKanbanViewProps = {
  tasks: Task[];
  /** Gates abiertas, en su propia fila arriba de las columnas. */
  gates?: Task[];
  sort: TaskSort;
  group: TaskGroupBy;
  /** Abre una tarea. Se pasa a cada tarjeta; sin esto el kanban es sólo informativo. */
  onOpenTask?: (task: Task) => void;
};

/**
 * Vista kanban: un grupo por columna, con scroll horizontal, y las gates abiertas en una fila
 * aparte arriba. Los estados `done` y `canceled` se excluyen del kanban, también cuando el alcance
 * superior entrega el historial cerrado completo.
 *
 * A diferencia de la lista, acá la cabecera **siempre** se muestra, incluso con `group === "none"`:
 * sin ella la columna sería una caja sin nombre.
 *
 * El `min-h-[calc(100vh-180px)]` reserva el alto del chrome (breadcrumb + toolbar) para que las
 * columnas lleguen al fondo sin empujar la página; por eso el alto no es un valor fijo.
 */
export function TaskKanbanView(props: TaskKanbanViewProps) {
  const gates = () => props.gates ?? [];
  const groups = () => taskGroups(
    props.tasks.filter((task) => task.status !== "done" && task.status !== "canceled"),
    props.group,
    props.sort,
  ).filter((group) => group.status !== "done" && group.status !== "canceled");
  return (
    <div class="flex h-full min-h-[calc(100vh-180px)] w-full flex-col gap-3">
      <Show when={gates().length > 0}>
        <section data-testid="tasks-gates" class="mx-3 shrink-0 overflow-hidden rounded-[10px] border border-line bg-surface sm:mx-0">
          <GroupHeader group={gateGroup(gates())} />
          <div class="flex flex-col gap-2 bg-raised p-2 sm:flex-row sm:overflow-x-auto">
            <For each={gates()}>{(gate) => <div class="w-full sm:w-[300px] sm:min-w-[280px] sm:shrink-0"><KanbanCard task={gate} onOpen={props.onOpenTask} /></div>}</For>
          </div>
        </section>
      </Show>
      <div data-testid="tasks-kanban-view" class="flex min-h-0 flex-1 flex-row items-stretch gap-3 overflow-x-auto pb-2">
        <For each={groups()}>{(group) => (
          <section data-testid="kanban-column" data-status={group.status} data-group={group.key} class="flex w-[300px] min-w-[280px] max-w-[320px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-line bg-surface">
            <GroupHeader group={group} />
            <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-raised p-2"><For each={group.tasks}>{(task) => <KanbanCard task={task} onOpen={props.onOpenTask} />}</For></div>
          </section>
        )}</For>
      </div>
    </div>
  );
}
