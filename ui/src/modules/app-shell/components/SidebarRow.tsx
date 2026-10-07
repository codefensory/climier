import type { JSX } from "solid-js";

export type SidebarRowProps = {
  label: string;
  active: boolean;
  onSelect: (event: MouseEvent) => void;
  /**
   * Contenido a la izquierda del rótulo, normalmente `<NavGlyph name="…" />`.
   *
   * Opcional a propósito: una fila de sólo texto es un render válido, y mantenerlo requerido
   * obligaba a poner JSX dentro de los `args` de Storybook. Un elemento JSX en `args` se
   * instancia una sola vez a nivel de módulo, y reutilizar ese nodo en dos montajes es un bug
   * en Solid.
   */
  icon?: JSX.Element;
  /** Marca la fila como seleccionable del panel de settings (atributo `data-item`). */
  dataItem?: string;
  /**
   * Fila que abre un menú en vez de navegar: usa `aria-haspopup` / `aria-expanded`,
   * y no marca `aria-current`.
   */
  menu?: boolean;
  expanded?: boolean;
  /** Fila de la navegación principal: tipografía más chica y peso medio al estar activa. */
  nav?: boolean;
};

/**
 * Fila del sidebar. Es presentacional puro: recibe valores planos y un `onSelect`,
 * así funciona igual en la app y en Storybook con Controls.
 */
export function SidebarRow(props: SidebarRowProps) {
  return (
    <button
      type="button"
      data-item={props.dataItem}
      data-project-trigger={props.menu ? "" : undefined}
      aria-current={!props.menu && props.active ? "page" : undefined}
      aria-haspopup={props.menu ? "menu" : undefined}
      aria-expanded={props.menu ? props.expanded : undefined}
      onClick={props.onSelect}
      class="flex h-9 w-full items-center gap-[9px] rounded-[10px] px-[5px] text-left text-muted transition-colors hover:bg-hover aria-expanded:bg-chip aria-[current=page]:bg-chip aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
      classList={{
        "text-[14px] leading-5 font-normal": props.nav,
        "text-[15px]": !props.nav,
        "aria-[current=page]:font-medium": props.nav,
      }}
    >
      {props.icon}
      <span class="truncate">{props.label}</span>
    </button>
  );
}
