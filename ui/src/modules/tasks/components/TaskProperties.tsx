import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { taskTag } from "../data/tags";
import { statusLabel } from "../data/statuses";
import { gatePurposeLabel } from "../data/gatePurposes";
import { StatusGlyph } from "./StatusGlyph";
import type { Task } from "../types";

export type TaskPropertiesProps = {
  task: Task;
  purpose?: string;
  resolutionMode?: string;
};

/** Una fila label/valor. El `dt` va apagado y el `dd` alineado a la derecha. */
function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-4 max-[639px]:grid max-[639px]:grid-cols-[104px_minmax(0,1fr)] max-[639px]:items-start max-[639px]:gap-2">
      <dt class="shrink-0 text-[12px] leading-4 text-muted max-[639px]:min-w-0">{props.label}</dt>
      <dd class="min-w-0 text-right text-[13px] leading-5 text-ink max-[639px]:w-full max-[639px]:text-left max-[639px]:whitespace-normal max-[639px]:break-words">{props.children}</dd>
    </div>
  );
}

/**
 * Propiedades del node: el bloque que en la referencia vive en la columna derecha.
 *
 * Los campos son los del modelo de climier: status derivado, tags, **claimed by** (un agente, no
 * una persona: no hay directorio de usuarios), initiative, domain y revision. No hay prioridad ni
 * efforts porque el board no los conoce; inventarlos haría que el detalle mienta.
 *
 * Es una `<dl>` y no una grilla de `<div>`: label y valor son semánticamente un par.
 */
export function TaskProperties(props: TaskPropertiesProps) {
  return (
    <dl class="space-y-3.5">
      <Row label="Status">
        <span class="inline-flex items-center gap-1.5">
          <StatusGlyph status={props.task.status} class="h-3.5 w-3.5" />
          {statusLabel(props.task.status)}
        </span>
      </Row>
      <Show when={props.purpose}>{(purpose) => <Row label="Purpose">{gatePurposeLabel(purpose())}</Row>}</Show>
      <Show when={props.task.tags.length > 0}>
        <Row label="Tags">
          <span class="inline-flex flex-wrap justify-end gap-1 max-[639px]:max-w-full max-[639px]:justify-start">
            <For each={props.task.tags}>{(tag) => {
              const style = taskTag(tag);
              return <span class="max-w-[120px] truncate rounded-[5px] px-1.5 py-[2px] text-[11px] leading-4 font-medium" style={{ "background-color": style.background, color: style.color }}>{tag}</span>;
            }}</For>
          </span>
        </Row>
      </Show>
      <Show when={props.task.claimedBy}>
        <Row label="Claimed by">
          <span classList={{ "text-tone-amber-ink": props.task.claimStale }} class="inline-flex items-center gap-1.5 max-[639px]:min-w-0 max-[639px]:flex-wrap">
            <span class="truncate max-[639px]:overflow-visible max-[639px]:whitespace-normal max-[639px]:break-words">{props.task.claimedBy}</span>
            <Show when={props.task.claimStale}><span class="rounded-[5px] bg-tone-amber-bg px-1.5 py-[1px] text-[10px] font-medium">stale</span></Show>
          </span>
        </Row>
      </Show>
      <Row label="Initiative">{props.task.initiative ?? <span class="text-muted">Empty</span>}</Row>
      <Show when={props.task.domain}><Row label="Domain">{props.task.domain}</Row></Show>
      <Show when={props.resolutionMode}>{(mode) => <Row label="Resolution mode">{mode().charAt(0).toUpperCase() + mode().slice(1)}</Row>}</Show>
      <Row label="Revision"><span class="tabular-nums">{props.task.revision}</span></Row>
    </dl>
  );
}
