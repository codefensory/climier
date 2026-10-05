/**
 * API pública de `app-shell`.
 *
 * El shell es el chrome de la aplicación: sidebar, breadcrumb, switcher de proyecto y el
 * frame del contenido. Exporta el contenedor, el provider y el controlador, además de los
 * componentes presentacionales y los datos de navegación que necesitan las stories.
 */

// Contenedor y estado del shell
export { AppShellContainer } from "./containers/AppShellContainer";
export type { AppShellContainerProps } from "./containers/AppShellContainer";

export { ShellProvider, useShell } from "./providers/ShellProvider";
export { useShellController } from "./controllers/useShellController";
export type { ShellController, ShellProjectIdentity } from "./controllers/useShellController";

// Componentes presentacionales
export { NavGlyph } from "./components/NavGlyph";
export type { NavGlyphProps } from "./components/NavGlyph";

export { ProjectIcon } from "./components/ProjectIcon";
export type { ProjectIconProps } from "./components/ProjectIcon";

export { ShowSidebarButton } from "./components/ShowSidebarButton";
export type { ShowSidebarButtonProps } from "./components/ShowSidebarButton";

export { SidebarControlIcon } from "./components/SidebarControlIcon";
export type { SidebarControlIconProps } from "./components/SidebarControlIcon";

export { SidebarHeading } from "./components/SidebarHeading";
export type { SidebarHeadingProps } from "./components/SidebarHeading";

export { SidebarRow } from "./components/SidebarRow";
export type { SidebarRowProps } from "./components/SidebarRow";

export { appNavigation, isGateDetailPath, isTaskDetailPath, navIconAssets, navPaths, pathForView, sections, SETTINGS_PANEL_PARAM, viewForPath } from "./data/navigation";
export { projects } from "./data/projects";

export type { NavIconAssets, NavItem, NavSection, Project } from "./types";
