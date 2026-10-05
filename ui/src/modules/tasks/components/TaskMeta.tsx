import { formatUpdatedAt } from "../utils/formatUpdatedAt";
import { TaskCounts } from "./TaskCounts";
import { TaskTags } from "./TaskTags";
import type { Task } from "../types";

export type TaskMetaProps = { task: Task };

/** Línea de metadatos de una fila: id, tags, contadores y última actividad. */
export function TaskMeta(props: TaskMetaProps) {
  return <div class="flex min-w-0 items-center gap-3"><span class="shrink-0 text-[11px] tabular-nums text-faint">{props.task.id}</span><TaskTags task={props.task} /><TaskCounts task={props.task} /><span class="shrink-0 text-[11px] tabular-nums text-faint">{formatUpdatedAt(props.task.updatedAt)}</span></div>;
}
