import { Show } from "solid-js";
import GridViewIcon from "@hugeicons/core-free-icons/GridViewIcon";
import { HugeIcon } from "../../core";

export type ProjectIconProps = {
  /** Fondo del chip, normalmente `var(--color-tone-*-bg)`. */
  background: string;
  /** Color de la letra del chip. */
  textColor: string;
  initial: string;
  /** Tamaño del switcher (28px) en vez del de breadcrumb (20px). */
  large?: boolean;
  /** Entrada "All projects": muestra un icono en vez de la letra. */
  all?: boolean;
};

/** Chip cuadrado con la letra (o el icono, para "All projects") de un proyecto. */
export function ProjectIcon(props: ProjectIconProps) {
  return (
    <span classList={{ "flex shrink-0 items-center justify-center": true, "h-7 w-7": props.large, "h-5 w-5": !props.large }}>
      <span
        classList={{
          "flex items-center justify-center rounded-[5px] font-semibold": true,
          "h-[26px] w-[26px] text-[11px]": props.large,
          "h-[18px] w-[18px] text-[10px]": !props.large,
        }}
        style={{ "background-color": props.background, color: props.textColor }}
        aria-hidden="true"
      >
        <Show when={props.all} fallback={props.initial}>
          <HugeIcon icon={GridViewIcon} class="h-3.5 w-3.5" strokeWidth="2" />
        </Show>
      </span>
    </span>
  );
}
