import { HashRouter, Route, type RouteSectionProps } from "@solidjs/router";
import type { JSX } from "solid-js";
import { AppShellContainer, ShellProvider, useShell } from "./modules/app-shell";
import { PlaceholderPage, SettingsPage, workspaceRoutes } from "./pages";
import { snapshot, usingRealSnapshot } from "./modules/tasks/data/source";

/**
 * Definiciones de ruta del workspace.
 *
 * Se derivan de la tabla de `app-shell` (`navPaths`) en vez de escribirse a mano: agregar una vista es
 * agregar una fila ahí y, si tiene contenido propio, una entrada en `pages`. El `*` final es el mismo
 * placeholder que antes recibía una vista desconocida.
 *
 * Queda como un array plano a propósito. El router interpreta `children` como definiciones de ruta y las
 * recorre sin aplanar (`asArray` en `createBranches`), así que un array anidado —por ejemplo un `.map()`
 * dentro de otro array— se leería como una ruta sin `path` ni componente.
 */
const routeDefs = [...workspaceRoutes.map((page) => <Route path={page.path} component={page.component} />), <Route path="*" component={PlaceholderPage} />];

/**
 * Composición de la aplicación.
 *
 * Es el único lugar donde se decide qué existe arriba de qué, y por eso los tres providers están acá y no
 * adentro de una página:
 *
 * - `HashRouter` tiene que envolver a todos: el shell lee la URL para saber qué vista está activa y el
 *   board lee y escribe sus search params.
 * - `ShellProvider` (vista activa, settings, sidebar) tiene que envolver al shell.
 *
 * Hasta la Fase 8b había un tercer provider, `TasksBoardProvider`, con la vista, el orden y la agrupación del
 * board. Ya no está: ese estado vive en la URL (`useTasksUrl()`), que hace lo mismo —sobrevivir al cambio de
 * vista— sin que existan dos lugares donde pueda estar.
 *
 * ### Por qué `HashRouter` y no `Router`
 *
 * Porque este repo **no tiene destino de despliegue**: no hay Dockerfile, ni nginx, ni config de host, y
 * el fallback a `index.html` que sí existe en el server de `climier/ui` es de otra aplicación. Con routing
 * por history, un link profundo (`/tasks`) es un 404 en cualquier host estático sin ese fallback; con
 * hash, `#/tasks` funciona siempre, incluso abriendo el `dist/` desde el disco.
 *
 * Además evita pisar la URL de Storybook: `HashRouter` navega con `pushState` sobre una URL que sólo
 * cambia el hash, así que el iframe sigue siendo `iframe.html?id=…&viewMode=story#/tasks` y recargar
 * vuelve a la story. Con `Router`, el camino quedaría en `/tasks` y recargar daría 404 en el dev server de
 * Storybook.
 *
 * Cambiar a paths reales el día que haya un host con fallback es cambiar `HashRouter` por `Router`.
 */
export default function App() {
  return (
    <HashRouter root={ShellLayout}>{routeDefs}</HashRouter>
  );
}

/**
 * Layout del shell: todo lo que envuelve al contenido de la ruta.
 *
 * Es el `root` del router, o sea el componente que se monta **una vez** y recibe en `props.children` la
 * página que matcheó. Ese es exactamente el lugar donde antes estaba `<WorkspaceViews><Dynamic/></…>`.
 */
function ShellLayout(props: RouteSectionProps) {
  return (
    <ShellProvider projectIdentity={usingRealSnapshot ? { root: snapshot.project.root, id: snapshot.project.project_id } : undefined}>
      <AppShellContainer>
        <WorkspaceFrame>{props.children}</WorkspaceFrame>
      </AppShellContainer>
    </ShellProvider>
  );
}

/**
 * Frame del workspace: el shell aporta la tarjeta y deja que cada página componga su propio PageFrame.
 *
 * El contenido viene de la ruta y no de un `<Dynamic>`: el router ya desmonta la página anterior y monta
 * la nueva al navegar, que es lo que hacía el `<Dynamic>` con el registro.
 */
function WorkspaceFrame(props: { children?: JSX.Element }) {
  const { settingsOpen } = useShell();

  return (
    <>
      <main
        data-testid="main-content"
        classList={{ "main-content-visible": !settingsOpen() }}
        aria-hidden={settingsOpen()}
        inert={settingsOpen()}
        class="main-content-view min-w-0 bg-white"
      >
        {props.children}
      </main>
      <SettingsPage />
    </>
  );
}
