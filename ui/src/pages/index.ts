/**
 * Páginas del workspace y el registro que las mapea desde la vista activa.
 *
 * El shell sólo ofrece la tarjeta; cada página usa el PageFrame compartido para su cabecera y columna de contenido.
 *
 * Las **rutas** no viven acá sino en `app-shell` (`navPaths`), que es de donde salen tanto los clicks del
 * sidebar como las `<Route>` que arma `App.tsx`: una sola tabla, dos consumidores.
 */
import type { Component } from "solid-js";
import { isGateDetailPath, isTaskDetailPath, navPaths, viewForPath } from "../modules/app-shell";
import { HomePage } from "./HomePage";
import { InitiativesPage } from "./InitiativesPage";
import { GatesPage } from "./GatesPage";
import { KnowledgesPage } from "./KnowledgesPage";
import { LoginPage } from "./LoginPage";
import { PageFrame } from "./PageFrame";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectsPage } from "./ProjectsPage";
import { TaskDetailPage } from "./TaskDetailPage";
import { TasksPage } from "./TasksPage";
import { ProjectStatePage } from "./ProjectStatePage";

export type WorkspacePage = {
  component: Component;
};

const pages: Record<string, WorkspacePage> = {
  Home: { component: HomePage },
  Tasks: { component: TasksPage },
  Initiatives: { component: InitiativesPage },
  Gates: { component: GatesPage },
  Knowledges: { component: KnowledgesPage },
  Projects: { component: ProjectsPage },
};

/** Vistas sin contenido propio y cualquier vista desconocida. */
const placeholder: WorkspacePage = { component: PlaceholderPage };

/**
 * Detalle de tarea: ocupa menos que el board.
 *
 * El detalle comparte el mismo frame y la misma columna que el resto de las páginas.
 */
const taskDetail: WorkspacePage = { component: TaskDetailPage };

export function workspacePageFor(view: string): WorkspacePage {
  return pages[view] ?? placeholder;
}

/**
 * Descriptor de la página que corresponde a un pathname. Un path desconocido cae en el placeholder.
 *
 * El detalle se resuelve **antes** de `viewForPath()` porque ese path también es "Tasks": sin este
 * chequeo, `/tasks/CLI-142` heredaría el descriptor del board.
 */
export function pageForPath(pathname: string): WorkspacePage {
  if (isTaskDetailPath(pathname) || isGateDetailPath(pathname)) return taskDetail;
  return workspacePageFor(viewForPath(pathname) ?? "");
}

/**
 * Rutas del workspace, armadas desde la tabla de `app-shell`.
 *
 * Se derivan en vez de escribirse a mano para que agregar una vista sea agregar una fila a `navPaths` y,
 * si tiene contenido propio, una entrada a `pages`. Con las rutas escritas aparte, una vista nueva podía
 * quedar navegable pero sin ruta (o al revés) sin que nada lo detectara.
 */
export const workspaceRoutes: { path: string; component: Component }[] = [
  ...Object.entries(navPaths).map(([view, path]) => ({ path, component: workspacePageFor(view).component })),
  // El detalle es la única ruta con parámetro y no puede salir de `navPaths`, que mapea una vista a un
  // path fijo. Va acá y no en `App.tsx` para que siga habiendo una sola tabla de rutas.
  { path: "/tasks/:id", component: TaskDetailPage },
  { path: "/gates/:id", component: TaskDetailPage },
];

export { GatesPage, HomePage, InitiativesPage, KnowledgesPage, LoginPage, PageFrame, PlaceholderPage, ProjectStatePage, ProjectsPage, TaskDetailPage, TasksPage };
