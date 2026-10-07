import { Show } from "solid-js";
import { formatUpdatedAt } from "../utils/formatUpdatedAt";
import { StatusGlyph } from "./StatusGlyph";
import { TaskCounts } from "./TaskCounts";
import { TaskTags } from "./TaskTags";
import type { Task } from "../types";

export type KanbanCardProps = {
  task: Task;
  /** Abre la tarea. Sin esto la tarjeta es sólo informativa. */
  onOpen?: (task: Task) => void;
};

/**
 * Tarjeta de la vista kanban.
 *
 * Sirve tanto para tasks como para gates (`kind`). El status se oculta y sólo aparece por debajo de
 * 639px: es redundante a propósito —la columna ya dice el status— pero al apilar las columnas en
 * pantallas angostas esa pista se pierde.
 *
 * El claim se muestra cuando existe, y en tono de alerta si está **stale** (más de 2 h): es la señal
 * de coordinación más importante del board, no un detalle.
 *
 * El contenedor es un `<div>` y no un `<article>`: cuando la tarjeta es accionable lleva
 * `role="button"`, y `article` no admite ese rol (axe lo reporta como `aria-allowed-role`).
 */
export function KanbanCard(props: KanbanCardProps) {
  const open = () => props.onOpen?.(props.task);
  return (
    <div
      data-testid="task-card"
      tabindex="0"
      role={props.onOpen ? "button" : undefined}
      onClick={props.onOpen ? open : undefined}
      onKeyDown={props.onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } } : undefined}
      class="flex w-full flex-col gap-2 rounded-[8px] bg-surface p-3 text-left shadow-[var(--elevation-tile)] transition-colors hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      classList={{ "cursor-pointer": props.onOpen !== undefined }}
    >
      <Show when={props.task.kind === "gate"}>
        <span class="w-fit rounded-[5px] bg-tone-amber-bg px-1.5 py-[2px] text-[10px] font-medium tracking-wide text-tone-amber-ink uppercase">Gate{props.task.purpose ? ` · ${props.task.purpose}` : ""}</span>
      </Show>
      <h4 class="text-[13px] font-medium leading-[18px] text-ink">{props.task.title}</h4>
      <Show when={props.task.description}><p class="line-clamp-2 text-[12px] leading-[17px] text-muted">{props.task.description}</p></Show>
      <TaskTags task={props.task} />
      <Show when={props.task.claimedBy}>
        <span classList={{ "text-tone-amber-ink": props.task.claimStale, "text-faint": !props.task.claimStale }} class="truncate text-[11px]">
          {props.task.claimStale ? "Stale claim · " : "Claimed by "}{props.task.claimedBy}
        </span>
      </Show>
      <div class="flex items-center justify-between gap-2 border-t border-hairline pt-2"><span class="flex min-w-0 flex-1 items-center gap-1"><StatusGlyph status={props.task.status} class="hidden h-3.5 w-3.5 shrink-0 max-[639px]:block" /><span class="min-w-0 truncate text-[11px] tabular-nums text-faint">{props.task.id}</span><span class="shrink-0 text-[11px] tabular-nums text-faint">{formatUpdatedAt(props.task.updatedAt)}</span></span><TaskCounts task={props.task} /></div>
    </div>
  );
}
