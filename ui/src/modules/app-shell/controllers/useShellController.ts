import { useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { BREAKPOINTS, useMediaQuery } from "../../core";
import { pathForView, SETTINGS_PANEL_PARAM, viewForPath } from "../data/navigation";
import { projects } from "../data/projects";
import type { NavItem, Project } from "../types";

export type ShellProjectIdentity = { root?: string | null; id?: string | null };

/**
 * Estado y acciones del chrome de la aplicación.
 *
 * Es un controlador, no un componente: no devuelve JSX y no lee nada fuera de un scope reactivo.
 * Los consumidores lo reciben por contexto (`ShellProvider` / `useShell`) y leen accessors, así
 * que la reactividad se mantiene sin pasar callbacks por props.
 */
export function useShellController(projectIdentity?: ShellProjectIdentity) {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setSearchParams] = useSearchParams();

  // Navegación: la URL es la fuente de verdad, no un signal.
  //
  // Las dos son **derivadas**, no estado propio. Con señales propias habría que mantenerlas sincronizadas
  // con el router en los dos sentidos (click → signal → URL y URL → signal), que es donde aparecen los
  // bugs de estado que se desincroniza; derivando, el botón de atrás y un link pegado a mano funcionan
  // sin código extra porque no hay nada que sincronizar.
  //
  // `viewForPath` devuelve `undefined` cuando el pathname no es ninguna vista — pasa en Storybook, donde
  // el iframe sirve `/iframe.html` — y ahí Home es el default correcto.
  const activeView = () => viewForPath(location.pathname) ?? "Home";
  const settingsOpen = () => query[SETTINGS_PANEL_PARAM] === "settings";
  const [activeItem, setActiveItem] = createSignal("Store details");

  // Chrome: sidebar colapsada (desktop) y drawer (compacto).
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);

  // Switcher de proyecto.
  const projectRootParts = projectIdentity?.root?.split(/[\\/]/).filter(Boolean) ?? [];
  const projectLabel = projectRootParts[projectRootParts.length - 1] || projectIdentity?.id?.trim() || projects[1].label;
  const availableProjects = projectIdentity
    ? [projects[0], { ...projects[1], label: projectLabel, initial: projectLabel.charAt(0).toUpperCase() }]
    : projects;
  const [selectedProject, setSelectedProject] = createSignal(availableProjects[1]);
  const [projectsMenuOpen, setProjectsMenuOpen] = createSignal(false);
  const [projectsMenuPosition, setProjectsMenuPosition] = createSignal({ left: 0, top: 0 });

  const isCompact = useMediaQuery(BREAKPOINTS.compact);
  const isNarrow = useMediaQuery(BREAKPOINTS.narrow);

  // En compacto el drawer reemplaza al sidebar; al salir de compacto no tiene sentido dejarlo abierto.
  createEffect(() => {
    if (!isCompact()) setDrawerOpen(false);
  });

  /** Oculta el sidebar: en compacto cierra el drawer, en desktop lo colapsa. */
  const hideSidebar = () => (isCompact() ? setDrawerOpen(false) : setSidebarCollapsed(true));

  /** Lo contrario de `hideSidebar`. */
  const showSidebar = () => (isCompact() ? setDrawerOpen(true) : setSidebarCollapsed(false));

  /**
   * Índice para saber si el sidebar está oculto según el modo.
   * Lo usan `aria-hidden` / `inert` de los dos `<aside>`.
   */
  const shellHidden = () => (isCompact() ? !drawerOpen() : sidebarCollapsed());

  /**
   * Navegación de la parte alta del sidebar (Home y el grupo Workspace).
   *
   * No cierra el panel de settings: el comportamiento original era así, y se preserva. Tampoco haría
   * falta: mientras settings está abierto el aside de la app queda `inert`, así que estos items no se
   * pueden clickear.
   */
  const selectView = (view: string) => {
    navigate(pathForView(view));
    setDrawerOpen(false);
  };

  /**
   * Navegación del grupo inferior (Settings y Account).
   *
   * A diferencia de `selectView`, este **sí** cierra settings al elegir Account. La asimetría
   * viene del código original y se mantiene para no cambiar comportamiento en una fase de
   * extracción.
   *
   * Settings abre el panel como search param en vez de navegar a otra vista: eso deja la vista actual
   * montada atrás (con su `aria-hidden` + `inert`) y hace que el panel se pueda recargar o compartir sin
   * perder sobre qué estaba abierto.
   */
  const selectBottomNavItem = (item: NavItem) => {
    if (item.label === "Settings") {
      setSearchParams({ [SETTINGS_PANEL_PARAM]: "settings" });
      setDrawerOpen(false);
      return;
    }
    navigate(pathForView(item.label));
    setDrawerOpen(false);
  };

  const selectSettingsItem = (label: string) => {
    setActiveItem(label);
    setDrawerOpen(false);
  };

  const backToApp = () => {
    // Borra el param del panel y deja la vista de atrás como estaba: el `null` es lo que `useSearchParams`
    // interpreta como "saca esta clave".
    setSearchParams({ [SETTINGS_PANEL_PARAM]: null });
    setDrawerOpen(false);
  };

  const selectProject = (project: Project) => {
    setSelectedProject(project);
    setProjectsMenuOpen(false);
  };

  const closeProjectsMenu = () => setProjectsMenuOpen(false);

  let projectMenuTrigger: HTMLButtonElement | undefined;

  const toggleProjectsMenu = (event: MouseEvent) => {
    if (projectsMenuOpen()) {
      setProjectsMenuOpen(false);
      return;
    }
    projectMenuTrigger = event.currentTarget as HTMLButtonElement;
    const rect = projectMenuTrigger.getBoundingClientRect();
    const menuWidth = 224;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    setProjectsMenuPosition({ left, top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 260)) });
    setProjectsMenuOpen(true);
  };

  onMount(() => {
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && drawerOpen() && !target.closest(".app-sidebar-wrap")) setDrawerOpen(false);
      if (projectsMenuOpen() && target instanceof Element && !target.closest("[data-project-trigger]") && !target.closest("[data-project-menu]")) setProjectsMenuOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (drawerOpen()) {
        setDrawerOpen(false);
        return;
      }
      if (projectsMenuOpen()) {
        setProjectsMenuOpen(false);
        projectMenuTrigger?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    });
  });

  return {
    // Lectura
    activeView,
    settingsOpen,
    activeItem,
    sidebarCollapsed,
    drawerOpen,
    selectedProject,
    availableProjects,
    projectsMenuOpen,
    projectsMenuPosition,
    isCompact,
    isNarrow,
    shellHidden,
    // Acciones
    selectView,
    selectBottomNavItem,
    selectSettingsItem,
    backToApp,
    selectProject,
    closeProjectsMenu,
    toggleProjectsMenu,
    hideSidebar,
    showSidebar,
  };
}

export type ShellController = ReturnType<typeof useShellController>;
