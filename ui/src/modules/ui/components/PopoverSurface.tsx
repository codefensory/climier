import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * Ancho de cada superficie flotante.
 *
 * Los nombres dicen el ancho, no quién la usa: `ui` no puede saber que existe un menú de "sort". Antes
 * se llamaban `sort` / `group` / `option` / `panel` y ese nombre era el único motivo por el que mudar
 * este archivo a la capa de primitivas requería pensarlo.
 */
export type PopoverVariant = "menuWide" | "menuNarrow" | "menuFit" | "panel";

/**
 * Clases de cada superficie flotante.
 *
 * Están juntas a propósito: las cuatro comparten `fixed`, fondo, sombra, `origin-top-left` y
 * la transición de entrada/salida, y las diferencias son sólo ancho, padding y redondeo. Tenerlas
 * en un solo lugar es lo que hace que la animación no se desincronice entre menús.
 *
 * `panel` es la única con `z-[100]`: los menús van en `z-[110]` para quedar por encima, incluido el
 * de opciones cuando se abre dentro del panel.
 */
const SURFACE_CLASS: Record<PopoverVariant, string> = {
  menuWide: "fixed z-[110] w-[220px] max-h-64 min-w-[156px] overflow-y-auto rounded-[10px] bg-overlay p-1 shadow-[var(--elevation-overlay)] origin-top-left",
  menuNarrow: "fixed z-[110] w-[180px] max-h-64 min-w-[156px] overflow-y-auto rounded-[10px] bg-overlay p-1 shadow-[var(--elevation-overlay)] origin-top-left",
  menuFit: "fixed z-[110] max-h-64 min-w-[156px] overflow-y-auto rounded-[10px] bg-overlay p-1 shadow-[var(--elevation-overlay)] origin-top-left",
  panel: "fixed z-[100] w-[min(560px,calc(100vw-24px))] max-h-[min(70vh,560px)] overflow-y-auto rounded-[14px] bg-overlay p-3 pt-2 shadow-[var(--elevation-overlay)] origin-top-right",
};

export type PopoverSurfaceProps = {
  variant: PopoverVariant;
  open: boolean;
  left: number;
  top: number;
  /** `listbox` para los menús de opciones, `menu` para los menús de acciones, `dialog` para el panel. */
  role: "listbox" | "menu" | "dialog";
  label: string;
  id?: string;
  testId?: string;
  /**
   * Marca el menú de opciones del filtro. Existe porque los selectores de descarte lo buscan por
   * este atributo: `PopoverSurface` es genérico, pero el hook de filtros necesita reconocerlo.
   */
  filterOptionMenu?: boolean;
  children: JSX.Element;
};

/**
 * Superficie flotante portaleada: posición absoluta, transición de entrada/salida y los atributos
 * de accesibilidad y de descarte.
 *
 * Antes este bloque estaba escrito **cuatro veces** (menú de sort, de group, de opciones y panel),
 * cada una con su copia de las clases de transición y de `data-open`/`aria-hidden`/`inert`. Una
 * divergencia entre copias no se nota mirando: se nota cuando un menú deja de cerrarse.
 *
 * El estado cerrado sigue en el DOM (`invisible` + `inert` + `pointer-events-none`) en vez de
 * desmontarse, para que la transición de salida se pueda animar.
 */
export function PopoverSurface(props: PopoverSurfaceProps) {
  return (
    <Portal>
      <div
        id={props.id}
        data-testid={props.testId}
        data-popup-surface
        data-filter-option-menu={props.filterOptionMenu ? "" : undefined}
        data-open={props.open ? "true" : "false"}
        role={props.role}
        aria-label={props.label}
        aria-hidden={!props.open}
        inert={!props.open}
        style={{ left: `${props.left}px`, top: `${props.top}px` }}
        classList={{
          [SURFACE_CLASS[props.variant]]: true,
          "visible pointer-events-auto translate-y-0 opacity-100": props.open,
          "invisible pointer-events-none -translate-y-[5px] opacity-0": !props.open,
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
}
