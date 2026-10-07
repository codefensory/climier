import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import climierLogoDark from "../../../assets/climier-logo-dark.png";
import climierLogo from "../../../assets/climier-logo.png";
import { HugeIcon, useSession, useTheme } from "../../core";
import { NavGlyph } from "../components/NavGlyph";
import { ProjectIcon } from "../components/ProjectIcon";
import { ShowSidebarButton } from "../components/ShowSidebarButton";
import { SidebarControlIcon } from "../components/SidebarControlIcon";
import { ThemeControl } from "../components/ThemeControl";
import { SidebarHeading } from "../components/SidebarHeading";
import { SidebarRow } from "../components/SidebarRow";
import { appNavigation } from "../data/navigation";
import { Button } from "../../ui";
import { useProjectData } from "../providers/ProjectProvider";
import { useShell } from "../providers/ShellProvider";

export type AppShellContainerProps = {
  children: JSX.Element;
};

export function AppShellContainer(props: AppShellContainerProps) {
  const {
    activeView,
    sidebarCollapsed,
    drawerOpen,
    selectedProject,
    availableProjects,
    projectsMenuOpen,
    projectsMenuPosition,
    isCompact,
    shellHidden,
    selectView,
    selectProject,
    toggleProjectsMenu,
    hideSidebar,
    showSidebar,
  } = useShell();
  const projectData = useProjectData();
  const session = useSession();
  const theme = useTheme();

  return (
    <div data-testid="dashboard-layout" class="min-h-screen w-full overflow-hidden bg-canvas font-sans text-ink">
      <div class="flex min-h-screen w-full">
        <div classList={{ "app-sidebar-wrap": true, "app-sidebar-collapsed": sidebarCollapsed(), "drawer-open": drawerOpen() }}>
          <div class="sidebar-nav-track">
            <aside data-testid="app-sidebar" aria-label="App sidebar" aria-hidden={shellHidden()} inert={shellHidden()} class="app-sidebar flex h-screen w-[248px] shrink-0 flex-col overflow-hidden px-3 pt-2 pb-2 antialiased">
              <header data-testid="app-brand" class="flex h-9 items-center gap-2 pl-[5px] pr-0">
                <img src={theme.resolved() === "dark" ? climierLogoDark : climierLogo} alt="Climier" class="h-[26px] w-auto shrink-0" />
                <span class="min-w-0 flex-1" aria-hidden="true" />
                <Button variant="icon" data-testid="app-sidebar-toggle" aria-label={isCompact() ? "Close navigation" : "Hide sidebar"} onClick={hideSidebar}><SidebarControlIcon /></Button>
              </header>
              <button type="button" aria-label="Search, Command K or slash" class="mt-3 flex h-9 w-full items-center gap-2 rounded-[10px] bg-chip px-2.5 text-left text-[14px] leading-5 text-muted transition-colors hover:bg-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
                <span class="flex-1">Search</span>
                <span class="flex items-center gap-1" aria-hidden="true"><kbd class="rounded-[5px] bg-surface px-1.5 py-0.5 text-[11px] leading-4 text-faint">⌘ K</kbd><kbd class="rounded-[5px] bg-surface px-1.5 py-0.5 text-[11px] leading-4 text-faint">/</kbd></span>
              </button>
              <button type="button" data-project-trigger aria-label={`Select project, ${selectedProject().label}`} aria-haspopup="menu" aria-expanded={projectsMenuOpen()} onClick={toggleProjectsMenu} class="mt-3 flex h-10 w-full items-center gap-2 rounded-[10px] bg-subtle px-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <ProjectIcon background={selectedProject().background} textColor={selectedProject().textColor} initial={selectedProject().initial} large />
                <span class="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-ink">{selectedProject().label}</span>
                <svg class="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>
              </button>
              <nav aria-label="Main navigation" class="mt-3 flex min-h-0 flex-1 flex-col">
                <SidebarRow nav label="Home" active={activeView() === "Home"} onSelect={() => selectView("Home")} icon={<NavGlyph name="home" />} />
                <div class="mt-3">
                  <SidebarHeading>Workspace</SidebarHeading>
                  <div class="space-y-0"><For each={appNavigation.slice(1)}>{(item) => <SidebarRow nav label={item.label} active={activeView() === item.label} onSelect={() => selectView(item.label)} icon={<NavGlyph name={item.icon} />} />}</For></div>
                </div>
                <div class="mt-auto border-t border-hairline pt-2">
                  <Button variant="ghost" class="w-full justify-start px-2.5 text-muted" data-testid="logout" onClick={session.logout}>Log out</Button>
                </div>
              </nav>
              <Portal>
                <div id="projects-menu" data-project-menu data-popup-surface data-open={projectsMenuOpen() ? "true" : "false"} role="menu" aria-label="Projects" aria-hidden={!projectsMenuOpen()} inert={!projectsMenuOpen()} style={{ left: `${projectsMenuPosition().left}px`, top: `${projectsMenuPosition().top}px` }} classList={{ "fixed z-[100] w-[224px] rounded-[14px] bg-overlay px-2 py-[6px] shadow-[var(--elevation-overlay)] origin-top-left": true, "visible pointer-events-auto translate-y-0 opacity-100": projectsMenuOpen(), "invisible pointer-events-none -translate-y-[5px] opacity-0": !projectsMenuOpen() }}>
                  <For each={availableProjects()}>{(project) => (
                    <button type="button" role="menuitemradio" aria-checked={selectedProject().projectId === project.projectId} onClick={[selectProject, project]} class="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2 text-left text-[14px] leading-5 text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:bg-canvas focus-visible:outline-2 focus-visible:outline-ink">
                      <ProjectIcon background={project.background} textColor={project.textColor} initial={project.initial} />
                      <span class="truncate">{project.label}</span>
                      <span class="ml-auto flex h-4 w-4 shrink-0 items-center justify-center text-faint" aria-hidden="true"><Show when={selectedProject().projectId === project.projectId}><span>✓</span></Show></span>
                    </button>
                  )}</For>
                </div>
              </Portal>
            </aside>
          </div>
        </div>
        <div classList={{ "main-content-frame": true, "drawer-content-shift": isCompact() && drawerOpen() }}>
          <div data-testid="tasks-breadcrumb" class="tasks-shell-breadcrumb flex h-9 items-center gap-3 px-4">
            <ShowSidebarButton visible={shellHidden} onShow={showSidebar} />
            <ThemeControl />
            <nav aria-label="Breadcrumb" class="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
              <Show when={activeView() === "Tasks"} fallback={<span class="truncate font-medium text-ink">{activeView()}</span>}>
                <span class="flex shrink-0 items-center gap-1.5 text-muted"><HugeIcon icon={Task01Icon} class="h-4 w-4 shrink-0" />Tasks</span>
                <span class="shrink-0 text-ghost" aria-hidden="true">/</span>
                <button type="button" data-project-trigger aria-label={`Select project, ${selectedProject().label}`} aria-haspopup="menu" aria-expanded={projectsMenuOpen()} aria-controls="projects-menu" onClick={toggleProjectsMenu} class="flex min-w-0 items-center gap-1.5 rounded-[6px] text-left font-medium text-ink transition-colors hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink">
                  <ProjectIcon background={selectedProject().background} textColor={selectedProject().textColor} initial={selectedProject().initial} />
                  <span class="truncate">{selectedProject().label}</span>
                  <svg class="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>
                </button>
              </Show>
            </nav>
            <Show when={projectData.connection() !== "live"}>
              <div data-testid="live-status" role="status" class="flex shrink-0 items-center gap-2 text-[12px] text-tone-amber-ink">
                <span>{projectData.connection() === "offline" ? "Offline" : "Stale"}</span>
                <Show when={projectData.lastUpdated()}>{(updated) => <span class="text-faint">Updated {new Date(updated()).toLocaleTimeString()}</span>}</Show>
                <button type="button" class="font-medium underline underline-offset-2" onClick={projectData.retry}>Retry</button>
              </div>
            </Show>
          </div>
          <main data-testid="main-content" class="main-content-view main-content-visible">
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}
