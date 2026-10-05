import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { BREAKPOINTS, useMediaQuery } from "../../core";
import { useProjectData } from "../providers/ProjectProvider";
import { pathForView, viewForPath } from "../data/navigation";
import type { NavItem, Project } from "../types";

export type ShellProjectIdentity = { root?: string | null; id?: string | null };

const PROJECT_STYLES = [
  ["var(--color-tone-green-bg)", "var(--color-tone-green-ink)"],
  ["var(--color-tone-amber-bg)", "var(--color-tone-amber-ink)"],
  ["var(--color-tone-blue-bg)", "var(--color-tone-blue-ink)"],
  ["var(--color-tone-mauve-bg)", "var(--color-tone-mauve-ink)"],
] as const;

export function useShellController() {
  const location = useLocation();
  const navigate = useNavigate();
  const projectData = useProjectData();

  const activeView = () => viewForPath(location.pathname) ?? "Home";
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [projectsMenuOpen, setProjectsMenuOpen] = createSignal(false);
  const [projectsMenuPosition, setProjectsMenuPosition] = createSignal({ left: 0, top: 0 });

  const availableProjects = createMemo<Project[]>(() => projectData.projects().map((project, index) => {
    const [background, textColor] = PROJECT_STYLES[index % PROJECT_STYLES.length];
    const label = project.name?.trim() || project.project_id;
    return { projectId: project.project_id, label, background, textColor, initial: label.charAt(0).toUpperCase() };
  }));
  const selectedProject = createMemo<Project>(() => availableProjects().find((project) => project.projectId === projectData.projectId()) ?? availableProjects()[0] ?? {
    projectId: "",
    label: "No project",
    background: "var(--color-chip)",
    textColor: "var(--color-muted)",
    initial: "?",
  });

  const isCompact = useMediaQuery(BREAKPOINTS.compact);
  const isNarrow = useMediaQuery(BREAKPOINTS.narrow);
  createEffect(() => {
    if (!isCompact()) setDrawerOpen(false);
  });

  const hideSidebar = () => (isCompact() ? setDrawerOpen(false) : setSidebarCollapsed(true));
  const showSidebar = () => (isCompact() ? setDrawerOpen(true) : setSidebarCollapsed(false));
  const shellHidden = () => (isCompact() ? !drawerOpen() : sidebarCollapsed());

  const projectSearch = () => {
    const projectId = new URLSearchParams(location.search).get("project");
    return projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  };

  const selectView = (view: string) => {
    navigate(`${pathForView(view)}${projectSearch()}`);
    setDrawerOpen(false);
  };

  const selectBottomNavItem = (item: NavItem) => {
    selectView(item.label);
  };

  const selectProject = (project: Project) => {
    projectData.selectProject(project.projectId);
    setProjectsMenuOpen(false);
    setDrawerOpen(false);
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
    activeView,
    sidebarCollapsed,
    drawerOpen,
    selectedProject,
    availableProjects,
    projectsMenuOpen,
    projectsMenuPosition,
    isCompact,
    isNarrow,
    shellHidden,
    selectView,
    selectBottomNavItem,
    selectProject,
    closeProjectsMenu,
    toggleProjectsMenu,
    hideSidebar,
    showSidebar,
  };
}

export type ShellController = ReturnType<typeof useShellController>;
