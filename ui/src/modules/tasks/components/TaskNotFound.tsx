import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { Show } from "solid-js";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";

export type TaskNotFoundProps = {
  /** El id que se buscó, si la URL traía uno. */
  id?: string;
  entity?: "task" | "gate";
  backLabel?: string;
  onBack?: () => void;
};

/**
 * Estado vacío del detalle: la URL apunta a una tarea que no existe.
 *
 * Se muestra **en lugar** del detalle y no como un cartel encima, porque no hay nada que mostrar
 * detrás. Es un caso real: un link viejo o un id mal tipeado.
 */
export function TaskNotFound(props: TaskNotFoundProps) {
  return (
    <div class="mx-auto flex w-full max-w-[420px] flex-col items-center gap-3 py-16 text-center">
      <span class="flex h-10 w-10 items-center justify-center rounded-full bg-sunken text-faint">
        <HugeIcon icon={Search01Icon} class="h-5 w-5" strokeWidth="1.6" />
      </span>
      <h1 class="text-[16px] leading-6 font-medium text-ink">{props.entity === "gate" ? "Gate" : "Task"} not found</h1>
      <p class="text-[13px] leading-5 text-muted">
        We couldn’t find {props.id ? <span class="tabular-nums text-ink-soft">{props.id}</span> : `that ${props.entity ?? "task"}`}. It may have been removed, or the link may be wrong.
      </p>
      <Show when={props.onBack}>
        <Button variant="outline" class="mt-1" onClick={() => props.onBack?.()}>Back to {props.backLabel ?? "tasks"}</Button>
      </Show>
    </div>
  );
}
