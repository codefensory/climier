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

/** A project from the authenticated server catalog, with presentation tokens for the switcher. */
export type Project = {
  projectId: string;
  label: string;
  background: string;
  textColor: string;
  initial: string;
};

/** Mapa de nombre semántico → asset de Hugeicons, usado por la navegación. */
export type NavIconAssets = Record<string, HugeIconAsset>;
