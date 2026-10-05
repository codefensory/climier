import { HugeIcon } from "../../core";
import { navIconAssets } from "../data/navigation";

export type NavGlyphProps = {
  /** Clave dentro de `navIconAssets`. */
  name: string;
};

/**
 * Icono de una fila de navegación: wrapper de 20px y trazo 1.8 sobre un icono de 16px, que es
 * el par que fija `AGENTS.md` para navegación.
 *
 * El tamaño es fijo a propósito: no es un icono configurable, es *el* icono del sidebar. Si
 * necesitás otro tamaño, usá `HugeIcon` directamente.
 */
export function NavGlyph(props: NavGlyphProps) {
  return (
    <span class="flex h-5 w-5 shrink-0 items-center justify-center">
      <HugeIcon icon={navIconAssets[props.name]} class="h-4 w-4" strokeWidth="1.8" />
    </span>
  );
}
