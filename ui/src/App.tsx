import { HashRouter, Route, type RouteSectionProps } from "@solidjs/router";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { AppShellContainer, ProjectProvider, ShellProvider, useProjectData } from "./modules/app-shell";
import { RuntimeProvider, SessionProvider, useRuntime, useSession } from "./modules/core";
import { snapshot as fixtureSnapshot } from "./modules/tasks/data/source";
import { LoginPage, PlaceholderPage, ProjectStatePage, workspaceRoutes } from "./pages";

const routeDefs = [...workspaceRoutes.map((page) => <Route path={page.path} component={page.component} />), <Route path="*" component={PlaceholderPage} />];

export type AppProps = {
  mode?: "live" | "fixture";
};

function App(props: AppProps = {}) {
  return (
    <RuntimeProvider mode={props.mode ?? "live"} fixtureSnapshot={fixtureSnapshot}>
      <HashRouter root={RootLayout}>{routeDefs}</HashRouter>
    </RuntimeProvider>
  );
}

function RootLayout(props: RouteSectionProps) {
  return <SessionProvider><AuthenticatedLayout>{props.children}</AuthenticatedLayout></SessionProvider>;
}

function AuthenticatedLayout(props: { children?: JSX.Element }) {
  const runtime = useRuntime();
  const session = useSession();
  const fixture = runtime.mode === "fixture";
  return (
    <Show when={fixture || session.authenticated()} fallback={<LoginPage />}>
      <ProjectProvider mode={runtime.mode} fixtureSnapshot={runtime.fixtureSnapshot}>
        <WorkspaceLayout>{props.children}</WorkspaceLayout>
      </ProjectProvider>
    </Show>
  );
}

export default App;

function WorkspaceLayout(props: { children?: JSX.Element }) {
  const data = useProjectData();
  return (
    <Show when={data.projectStatus() === "ready"} fallback={<ProjectStatePage />}>
      <ShellProvider>
        <AppShellContainer>{props.children}</AppShellContainer>
      </ShellProvider>
    </Show>
  );
}
