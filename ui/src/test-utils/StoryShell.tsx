import { HashRouter, Route } from "@solidjs/router";
import type { JSX } from "solid-js";
import { ProjectProvider, ShellProvider } from "../modules/app-shell";
import { RuntimeProvider, SessionProvider } from "../modules/core";
import { snapshot as fixtureSnapshot } from "../modules/tasks/data/source";

/**
 * Deja la URL en un estado conocido.
 *
 * Hace falta porque la URL **sobrevive entre stories**: el corredor de tests reusa la página, así que una
 * story que navega deja el hash puesto y la siguiente arranca ahí. Es la misma clase de fuga que los
 * `globals.viewport` (documentada en la Fase 7): el estado que vive fuera del árbol de componentes no se
 * limpia solo entre stories.
 *
 * Medido en la Fase 7 con viewport: `Tasks Flow` corría a 639 después de `Narrow` y a 1440 sola. Acá el
 * equivalente es arrancar en `/tasks` creyendo que se arranca en Home.
 *
 * `replaceState` y no `location.hash = …` para no disparar un `hashchange` que un router todavía montado
 * de la story anterior podría escuchar.
 */
export function resetStoryUrl(path = "/") {
  window.history.replaceState(null, "", `#${path}`);
}

export type StoryShellProps = {
  /**
   * URL con la que arranca la story, por ejemplo `"/tasks?view=kanban"`. Default `/`.
   *
   * Es la forma de mostrar en Storybook un estado que en la app sólo se alcanza navegando — que es
   * justamente para lo que sirve tener el estado en la URL.
   */
  path?: string;
  /** Envuelve además en `ShellProvider`, para componentes que usan `useShell()`. */
  shell?: boolean;
  children: JSX.Element;
};

/**
 * Monta contenido dentro de un router, y opcionalmente del shell.
 *
 * Lo usan las stories que montan un componente suelto —sin pasar por `App`— pero que necesita el router:
 * las que leen `useShell()` (que deriva la vista activa de la URL) y, desde la Fase 8b, las que leen los
 * search params del board.
 *
 * `App` **no** usa esto: arma su propio `HashRouter` porque una app tiene que poder montarse sola. Acá el
 * router se declara por fuera porque la story reemplaza a `App`.
 */
export function StoryShell(props: StoryShellProps) {
  resetStoryUrl(props.path ?? "/");

  const Page = () => (
    <RuntimeProvider mode="fixture" fixtureSnapshot={fixtureSnapshot}>
      <SessionProvider probe={false}>
        <ProjectProvider mode="fixture" fixtureSnapshot={fixtureSnapshot}>
          {props.shell ? <ShellProvider>{props.children}</ShellProvider> : props.children}
        </ProjectProvider>
      </SessionProvider>
    </RuntimeProvider>
  );

  return (
    <HashRouter>
      <Route path="*" component={Page} />
    </HashRouter>
  );
}
