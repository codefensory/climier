import { Show } from "solid-js";
import { Chip } from "../../ui";
import { taskTag } from "../data/tags";
import { StatusGlyph } from "./StatusGlyph";
import type { FilterOption } from "../types";

export type FilterOptionContentProps = { option: FilterOption };

/**
 * Contenido de una opción en los menús de filtro: glyph de status, chip de tag o texto.
 *
 * Los tres casos son excluyentes y el orden importa —status, después chip, después texto—, así que
 * el `Show` con `fallback` sostiene la misma precedencia que el ternario original.
 */
export function FilterOptionContent(props: FilterOptionContentProps) {
  const style = () => taskTag(props.option.label);
  return <span class="flex min-w-0 items-center gap-2">{props.option.status && <StatusGlyph status={props.option.status} class="h-4 w-4 shrink-0" />}<Show when={props.option.chip} fallback={<span class="truncate">{props.option.label}</span>}><Chip background={style().background} color={style().color}>{props.option.label}</Chip></Show></span>;
}
