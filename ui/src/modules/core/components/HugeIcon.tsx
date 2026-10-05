import { For } from "solid-js";
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { HugeIconAsset } from "../types/hugeicon";

export type HugeIconProps = {
  /** Asset de Hugeicons: `@hugeicons/core-free-icons/<Nombre>Icon`. */
  icon: HugeIconAsset;
  /** Clases del `<svg>`. Obligatorio a propósito: el tamaño lo decide quien consume. */
  class: string;
  /** Grosor del trazo. 1.8 a 16px; más fino en tamaños menores. Por defecto 1.6. */
  strokeWidth?: string;
};

/**
 * Renderiza un icono de Hugeicons con el peso de trazo del proyecto.
 *
 * Los assets del paquete son listas de tuplas `[tag, atributos]`, así que se renderizan con
 * `<Dynamic>` en lugar de inyectar HTML crudo.
 */
export function HugeIcon(props: HugeIconProps) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <For each={props.icon}>
        {([tag, attributes]) => {
          const iconAttributes = { ...attributes, "stroke-width": props.strokeWidth ?? "1.6" };
          return <Dynamic component={tag as keyof JSX.IntrinsicElements} {...iconAttributes} />;
        }}
      </For>
    </svg>
  );
}
