import Tick01Icon from "@hugeicons/core-free-icons/Tick01Icon";
import type { JSX } from "solid-js";
import { HugeIcon } from "../../core";

/**
 * Fila de un menú portaleado: la opción de Sort, de Group y del menú de valores del filtro.
 *
 * Era **la duplicación más grande del proyecto**: cuatro copias de la misma fila en tres archivos, cada
 * una con su versión del slot del check. Una divergencia ahí no se ve mirando un menú; se ve cuando uno
 * de los cuatro deja de marcar la opción elegida.
 *
 * El primitivo se queda con lo que era idéntico —la fila completa y el slot del check— y devuelve los
 * **dos extremos**, que sí son distintos:
 *
 * - `leading`: el slot de la izquierda. Sort y Group pasan un icono envuelto en un cuadrado de 20px; el
 *   menú de filtros pasa un glyph de status, y sólo cuando el campo elegido es un status.
 * - `label`: la etiqueta ya renderizada. Sort y Group pasan texto plano; el filtro pasa el contenido
 *   que decide entre glyph, chip o texto.
 *
 * Devolver los extremos en vez de recibir `option` y ramificar adentro no es una concesión: es lo que
 * evita que el primitivo tenga que conocer `sortFields`, `groupFields` y `FilterOption` a la vez.
 */
export type MenuOptionProps = {
  selected: boolean;
  onSelect: () => void;
  leading?: JSX.Element;
  label: JSX.Element;
};

export function MenuOption(props: MenuOptionProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
      class="flex min-h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] text-ink-soft transition hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
    >
      {props.leading}
      {props.label}
      <span class="ml-auto flex h-4 w-4 shrink-0 items-center justify-center text-tone-green-ink">
        {props.selected && <HugeIcon icon={Tick01Icon} class="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}
