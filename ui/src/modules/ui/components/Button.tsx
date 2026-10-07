import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

/**
 * Formas de botón de la app.
 *
 * No es un catálogo de ideas: son **las recetas que ya existían**, con nombre. Ninguna clase cambió al
 * pasar por acá, y por eso el refactor es verificable — el DOM tiene que salir byte a byte igual.
 *
 * | variante | quién la usa | alto |
 * |---|---|---|
 * | `ghost` | los disparadores de Sort, Group y Filter | 32px |
 * | `segment` | List / Kanban (control segmentado) | 28px |
 * | `icon` | colapsar y mostrar la sidebar | 28×28 |
 * | `outline` | la acción de la vista (`PageAction`) | por padding |
 * | `solid` | Save | por padding |
 *
 * ### Lo que NO hace esta capa (todavía)
 *
 * Las alturas no están normalizadas: `ghost` mide 32px y `segment` 28px **hoy**, en el código original.
 * Unificarlas es un cambio visual, no un refactor, y hacerlo en la misma pasada habría vuelto imposible
 * distinguir una regresión de una decisión. Acá la escala quedó a la vista en una sola tabla, que es lo
 * que hacía falta para decidirla después con una story delante.
 *
 * Tampoco absorbe los tres botones sueltos del panel de filtros (Add filter, Add group, Clear all): sus
 * tres cadenas de clases son distintas entre sí (alto, tamaño de letra y `gap`), así que plegarlas
 * también sería un cambio visual. Quedan propios y anotados como deuda.
 */
export type ButtonVariant = "ghost" | "segment" | "icon" | "outline" | "solid";

/**
 * Estados visuales.
 *
 * Cada variante declara los suyos, así que `active` sólo existe en `segment` y `open` sólo en `ghost`.
 * Un estado que la variante no declara cae en `idle`, que puede ser la cadena vacía.
 */
export type ButtonState = "idle" | "open" | "applied" | "active";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  ghost: "flex h-8 items-center gap-1.5 rounded-[8px] px-1.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink sm:px-2.5",
  segment: "flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ink sm:px-2.5",
  icon: "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-muted transition hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
  outline: "shrink-0 rounded-[8px] bg-subtle px-3 py-2 text-[13px] font-medium text-muted transition hover:bg-chip hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
  solid: "shrink-0 rounded-[8px] bg-ink px-4 py-2 text-[13px] font-medium text-on-strong transition hover:bg-ink-soft",
};

/**
 * Clases de estado, por variante.
 *
 * El orden importa: en el DOM medido, `class` se aplica primero y el estado se agrega al final de la
 * cadena. `Button` compone en ese mismo orden.
 *
 * Nombres: `open` es "el menú que este botón abre está abierto"; `applied` es "hay algo que no es el
 * valor por defecto" (un orden distinto del default); `active` es "este segmento es el elegido". Son
 * tres cosas distintas y por eso son tres nombres.
 */
const STATE_CLASS: Record<ButtonVariant, Partial<Record<ButtonState, string>>> = {
  ghost: {
    idle: "text-muted hover:bg-subtle hover:text-ink",
    open: "bg-subtle text-ink",
    applied: "text-ink",
  },
  segment: {
    idle: "text-muted hover:text-ink",
    active: "bg-surface text-ink shadow-[var(--elevation-control)]",
  },
  icon: {},
  outline: {},
  solid: {},
};

export type ButtonProps = {
  variant: ButtonVariant;
  /** Default `idle`. */
  state?: ButtonState;
  /**
   * Clases extra, van **primero** en la cadena. Existen para modificadores de layout, no de aspecto:
   * el disparador de filtros necesita `relative` porque adentro lleva el badge con la cuenta.
   */
  class?: string;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class">;

/**
 * Botón.
 *
 * `type="button"` es fijo a propósito: los 13 usos son botones de acción y ninguno envía un formulario.
 * Cuando aparezca el primero que sí lo haga, se le agrega la prop y se decide entonces, en vez de
 * dejar hoy la puerta abierta a un submit accidental.
 */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "state", "class", "children"]);

  const className = () => {
    const extra = local.class ? local.class + " " : "";
    const state = STATE_CLASS[local.variant][local.state ?? "idle"];
    return extra + VARIANT_CLASS[local.variant] + (state ? " " + state : "");
  };

  return (
    <button type="button" {...rest} class={className()}>
      {local.children}
    </button>
  );
}
