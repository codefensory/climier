export type SidebarControlIconProps = {
  /** Dibuja la flecha apuntando hacia el otro lado (sidebar visible). */
  open?: boolean;
  class?: string;
};

/**
 * Icono de control del sidebar.
 *
 * SVG propio a propósito: Hugeicons no tiene este panel con la flecha integrada, y la flecha
 * tiene que alternar de lado sin cambiar de icono. Mismo peso óptico que los Hugeicons (1.8).
 */
export function SidebarControlIcon(props: SidebarControlIconProps) {
  return (
    <svg
      class={props.class ?? "h-[18px] w-[18px]"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
      {props.open ? <path d="m15 9 3 3-3 3" /> : <path d="m16 9-3 3 3 3" />}
    </svg>
  );
}
