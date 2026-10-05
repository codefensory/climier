import type { JSX } from "solid-js";

/**
 * Píldora de etiqueta, con el color que le corresponde.
 *
 * El fondo y el color de letra llegan como **strings sueltos** y no como un tipo del dominio de tasks:
 * `ui` no puede depender de `tasks`. El llamador sabe de dónde sale el color (la paleta curada de
 * labels, o el tono derivado por hash), y acá sólo se pinta.
 *
 * Estaba escrito dos veces: en `FilterOptionContent` (la opción de un menú de filtro) y en
 * `GroupHeader` (la cabecera de un grupo agrupado por label).
 */
export type ChipProps = {
  background: string;
  color: string;
  children: JSX.Element;
};

export function Chip(props: ChipProps) {
  return (
    <span
      class="max-w-full truncate rounded-[5px] px-1.5 py-[2px] text-[11px] leading-4 font-medium"
      style={{ "background-color": props.background, color: props.color }}
    >
      {props.children}
    </span>
  );
}
