import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import Target01Icon from "@hugeicons/core-free-icons/Target01Icon";
import { Show, Switch, Match } from "solid-js";
import { HugeIcon, tint } from "../../core";
import { Chip } from "../../ui";
import { taskTag } from "../data/tags";
import { StatusGlyph } from "./StatusGlyph";
import type { TaskGroupGlyph, TaskGroupView } from "../types";

export type GroupHeaderProps = {
  group: TaskGroupView;
  /**
   * El grupo vive dentro de un `<details class="group">`: antepone un chevron que rota al abrir.
   *
   * El marcador nativo del `<summary>` se oculta en el consumidor (`list-none`), porque el triángulo
   * del navegador queda fuera del padding de la fila y desalineado.
   */
  collapsible?: boolean;
};

/**
 * Guard de tipo del discriminante.
 *
 * Existe porque `<Match>` necesita un valor que TS pueda estrechar: con
 * `props.glyph.kind === "status" && props.glyph` el tipo queda en `false | TaskGroupGlyph` y no hay
 * narrowing. Así el glyph sigue siendo data serializable en vez de un `JSX.Element` en los datos.
 */
function glyphOfKind<K extends TaskGroupGlyph["kind"]>(glyph: TaskGroupGlyph, kind: K): Extract<TaskGroupGlyph, { kind: K }> | undefined {
  return glyph.kind === kind ? (glyph as Extract<TaskGroupGlyph, { kind: K }>) : undefined;
}

/** El glyph que identifica al grupo: hexágono, chip de tag, icono de initiative/gate o "todas". */
function GroupGlyph(props: { glyph: TaskGroupGlyph }) {
  return (
    <Switch>
      <Match when={glyphOfKind(props.glyph, "status")}>{(glyph) => <StatusGlyph status={glyph().status} />}</Match>
      <Match when={glyphOfKind(props.glyph, "tag")}>{(glyph) => {
        const style = taskTag(glyph().tag);
        return <Chip background={style.background} color={style.color}>{glyph().tag}</Chip>;
      }}</Match>
      <Match when={props.glyph.kind === "initiative"}><HugeIcon icon={Rocket01Icon} class="h-4 w-4 shrink-0 text-muted" /></Match>
      <Match when={props.glyph.kind === "gate"}><HugeIcon icon={SecurityCheckIcon} class="h-4 w-4 shrink-0 text-tone-amber-ink" /></Match>
      <Match when={props.glyph.kind === "scope"}><HugeIcon icon={Target01Icon} class="h-4 w-4 shrink-0 text-muted" /></Match>
      <Match when={props.glyph.kind === "all"}><HugeIcon icon={Task01Icon} class="h-4 w-4 shrink-0 text-faint" /></Match>
    </Switch>
  );
}

/**
 * Cabecera de un grupo: glyph, título, cuántas tasks y el progreso del grupo.
 *
 * El progreso **ya viene calculado** en `group.progress` (ver `groupProgress()`): es el avance
 * promedio del trabajo vigente del grupo (lo terminado cuenta, lo cancelado no). `GroupHeader` sólo
 * lo dibuja.
 *
 * Fondo y borde inferior salen del mismo `color` del grupo con `tint()` a distinta intensidad.
 */
export function GroupHeader(props: GroupHeaderProps) {
  return (
    <div class="flex min-h-[40px] items-center gap-2.5 border-b border-hairline px-4 py-2" style={{ "background-color": tint(props.group.color, 7), "border-bottom-color": tint(props.group.color, 15) }}>
      <Show when={props.collapsible}>
        <HugeIcon icon={ArrowRight01Icon} class="disclosure-chevron h-3.5 w-3.5 shrink-0 text-muted transition-transform" strokeWidth="1.8" />
      </Show>
      <GroupGlyph glyph={props.group.glyph} />
      <Show when={!props.group.identityChip}><span class="text-[13px] font-medium text-ink">{props.group.label}</span></Show>
      <span class="shrink-0 text-[11px] text-faint">{props.group.count ?? props.group.tasks.length}</span>
      <Show when={!props.group.hideProgress}>
        <div class="ml-auto flex w-[108px] shrink-0 items-center gap-2" aria-label={`${props.group.progress}% progress`}>
          <div class="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-hairline"><div class="h-full rounded-full" style={{ width: `${props.group.progress}%`, "background-color": props.group.color }} /></div>
          <span class="w-7 text-right text-[10px] tabular-nums text-muted">{props.group.progress}%</span>
        </div>
      </Show>
    </div>
  );
}
