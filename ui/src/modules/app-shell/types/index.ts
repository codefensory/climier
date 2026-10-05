import type { HugeIconAsset } from "../../core";

/** Entrada del menú de navegación principal o del panel de settings. */
export type NavItem = {
  label: string;
  /** Clave dentro de `navIconAssets`. */
  icon: string;
};

/** Grupo de items del panel de settings, con su título. */
export type NavSection = {
  title: string;
  items: NavItem[];
};

/** Proyecto del workspace. */
export type Project = {
  label: string;
  /** Fondo del chip, normalmente `var(--color-tone-*-bg)`. */
  background: string;
  /** Color de la letra del chip. */
  textColor: string;
  /** Letra mostrada cuando no es la entrada "todos los proyectos". */
  initial: string;
  /** Entrada agregada "All projects": muestra un icono en vez de una letra. */
  all?: boolean;
};

/** Mapa de nombre semántico → asset de Hugeicons, usado por la navegación. */
export type NavIconAssets = Record<string, HugeIconAsset>;
