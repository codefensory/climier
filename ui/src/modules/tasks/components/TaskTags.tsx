import { For } from "solid-js";
import { taskTag } from "../data/tags";
import type { Task } from "../types";

export type TaskTagsProps = { task: Task };

/**
 * Chips de tags de una tarea.
 *
 * Muestra **como máximo 2** tags. `taskTag()` reemplaza al acceso directo al mapa: con un tag fuera
 * de la paleta, un acceso `styles[tag].background` tiraría `TypeError` y se caería la vista entera,
 * no sólo el chip.
 */
export function TaskTags(props: TaskTagsProps) {
  return (
    <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <For each={props.task.tags.slice(0, 2)}>{(tag) => {
        const style = taskTag(tag);
        return <span class="max-w-[100px] truncate rounded-[5px] px-1.5 py-[2px] text-[11px] leading-4 font-medium" style={{ "background-color": style.background, color: style.color }}>{tag}</span>;
      }}</For>
    </div>
  );
}
