import ArrowTurnBackwardIcon from "@hugeicons/core-free-icons/ArrowTurnBackwardIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkBadge01Icon from "@hugeicons/core-free-icons/CheckmarkBadge01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Comment01Icon from "@hugeicons/core-free-icons/Comment01Icon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import UserRemove01Icon from "@hugeicons/core-free-icons/UserRemove01Icon";
import { For, Show } from "solid-js";
import { HugeIcon, tint } from "../../core";
import type { HugeIconAsset } from "../../core";
import { Markdown } from "../../ui";
import type { TaskActivityEntry, TaskActivityKind } from "../types";

export type TaskActivityFeedProps = {
  activity: TaskActivityEntry[];
  /** `true` muestra cada comentario como fuente cruda en vez de markdown. Default `false`. */
  raw?: boolean;
};

/**
 * Glyph de cada tipo de evento, con su color.
 *
 * Cada acción del log de climier tiene su icono: así el historial se lee como una secuencia del
 * DAG (claim → submit → accept) y no como una lista de texto.
 */
const EVENT_GLYPH: Record<TaskActivityKind, { icon: HugeIconAsset; color: string }> = {
  created: { icon: CheckmarkCircle02Icon, color: "var(--color-tone-green-ink)" },
  comment: { icon: Comment01Icon, color: "var(--color-tone-blue-ink)" },
  claim: { icon: UserIcon, color: "var(--color-status-progress)" },
  release: { icon: UserRemove01Icon, color: "var(--color-faint)" },
  submit: { icon: SentIcon, color: "var(--color-tone-blue-ink)" },
  accept: { icon: CheckmarkCircle02Icon, color: "var(--color-tone-green-ink)" },
  reject: { icon: Cancel01Icon, color: "var(--color-tone-mauve-ink)" },
  update: { icon: Edit01Icon, color: "var(--color-muted)" },
  resolve: { icon: CheckmarkBadge01Icon, color: "var(--color-tone-green-ink)" },
  cancel: { icon: Cancel01Icon, color: "var(--color-faint)" },
  reopen: { icon: ArrowTurnBackwardIcon, color: "var(--color-tone-amber-ink)" },
  supersede: { icon: Link01Icon, color: "var(--color-tone-mauve-ink)" },
  link: { icon: Task01Icon, color: "var(--color-tone-blue-ink)" },
};

/** Círculo de 24px con el glyph del evento. */
function EventGlyph(props: { kind: TaskActivityKind }) {
  const glyph = () => EVENT_GLYPH[props.kind];
  return (
    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ "background-color": tint(glyph().color, 12), color: glyph().color }}>
      <HugeIcon icon={glyph().icon} class="h-3.5 w-3.5" strokeWidth="1.6" />
    </span>
  );
}

/**
 * Historial de la tarea.
 *
 * Cada entrada es agente + qué hizo + cuándo, en una sola línea; el comentario, si lo hay, va en una
 * burbuja debajo para que se lea como contenido y no como metadata.
 *
 * Es una `<ol>`: el orden cronológico es información, no decoración.
 */
export function TaskActivityFeed(props: TaskActivityFeedProps) {
  return (
    <ol class="flex flex-col gap-4">
      <For each={props.activity}>{(entry) => (
        <li class="flex gap-3">
          <EventGlyph kind={entry.kind} />
          <div class="min-w-0 flex-1 pt-px">
            <p class="text-[13px] leading-5 text-ink-soft">
              <span class="font-medium text-ink">{entry.author}</span> {entry.text} <span class="text-faint">{entry.at}</span>
            </p>
            <Show when={entry.comment}>{(comment) => (
              <div class="mt-2 rounded-[10px] bg-raised px-3 py-2">
                <Markdown source={comment()} raw={props.raw} class="text-[13px] leading-5 text-ink-soft" />
              </div>
            )}</Show>
          </div>
        </li>
      )}</For>
    </ol>
  );
}
