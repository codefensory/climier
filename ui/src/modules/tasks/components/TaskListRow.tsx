import { Show } from "solid-js";
import { StatusGlyph } from "./StatusGlyph";
import { TaskMeta } from "./TaskMeta";
import type { Task } from "../types";

export type TaskListRowProps = {
  task: Task;
  /**
   * Abre la tarea. Opcional a propósito: la fila sigue siendo presentacional y una story puede
   * montarla sin router. Cuando llega, la fila entera se comporta como un botón.
   */
  onOpen?: (task: Task) => void;
};

/**
 * Fila de la vista de lista. Presentacional pura: recibe una `Task` plana, así que los Controls de
 * Storybook funcionan y la story puede pasar datos extremos sin tocar estado global.
 *
 * Con `onOpen` la fila es accionable: `role="button"`, `tabindex` y `Enter`/`Espacio`. Sin `onOpen`
 * queda sólo enfocable, que es el estado en el que viven las stories y las otras vistas.
 */
export function TaskListRow(props: TaskListRowProps) {
  const open = () => props.onOpen?.(props.task);
  return (
    <div
      data-testid="task-row"
      tabindex="0"
      role={props.onOpen ? "button" : undefined}
      onClick={props.onOpen ? open : undefined}
      onKeyDown={props.onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } } : undefined}
      class="flex min-h-[64px] items-center justify-between gap-5 px-4 py-2.5 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ink"
      classList={{ "cursor-pointer": props.onOpen !== undefined }}
      style={{ "content-visibility": "auto", "contain-intrinsic-block-size": "auto 64px" }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <StatusGlyph status={props.task.status} class="h-4 w-4 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <Show when={props.task.kind === "gate"}>
              <span class="shrink-0 rounded-[5px] bg-tone-amber-bg px-1.5 py-[1px] text-[10px] font-medium tracking-wide text-tone-amber-ink uppercase">Gate</span>
            </Show>
            <h3 class="truncate text-[14px] font-medium leading-5 text-ink">{props.task.title}</h3>
          </div>
          <Show when={props.task.description}><p class="truncate text-[12px] leading-[18px] text-muted">{props.task.description}</p></Show>
        </div>
      </div>
      <div class="flex shrink-0 items-center"><TaskMeta task={props.task} /></div>
    </div>
  );
}
