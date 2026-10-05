# Storybook

Storybook 10 con `storybook-solidjs-vite`. La config vive en `.storybook/main.ts` y `.storybook/preview.tsx`.
**No** toques `vite.config.ts`: Storybook auto-fusiona la config de Vite del proyecto, así que no hace falta
`viteFinal`, y ya detecta Solid solo.

Dos cosas que si se rompen dejan todo inútil:

- `src/styles/style.css` **tiene que** estar importado en `.storybook/preview.tsx`. Sin eso no hay tokens ni
  Tailwind y todas las stories se ven sin estilo.
- Un decorador que devuelva JSX necesita `createJSXDecorator` de `storybook-solidjs-vite`. Un decorador
  normal no compila.

Addons: `addon-docs`, `addon-a11y`, `addon-vitest`. **No** instales `addon-essentials` ni `addon-interactions`
(están en core desde Storybook 9) ni un segundo paquete de iconos.

## Mirar una story rápido

```text
http://127.0.0.1:6006/iframe.html?id=<story-id>&viewMode=story     # sólo la story, sin manager
http://127.0.0.1:6006/?path=/story/<story-id>                      # con manager (panel de axe, controles)
```

El `story-id` sale del título y el nombre en kebab: `Pages/TasksPage` + `Kanban` → `pages-taskspage--kanban`.

Los `globals` de viewport **sólo** se aplican por la URL del manager, no por `iframe.html`: en el iframe no
hay addon panel y el ancho es el del viewport del navegador. Para capturas, fijá el tamaño por CDP
(`Emulation.setDeviceMetricsOverride`), que es lo que hace el arnés.

Una story cuyo contenido está en un `Portal` (menús, popovers) deja `#storybook-root` **vacío** desde el
punto de vista del árbol: el nodo se monta fuera. Si una verificación "no encuentra nada" en esa story, es
esto y no un bug.

## Convenciones de story en este repo

- Co-locada: `Foo.tsx` + `Foo.stories.tsx` en la misma carpeta.
- `title: "<Área>/<Componente>"` — `App`, `UI/*`, `Core/HugeIcon`, `AppShell/*`, `Tasks/*`, `Pages/*`.
- `parameters: { layout: "fullscreen" }` en casi todas: la app es una pantalla completa, no un componente
  centrado.
- Componentes **controlados**: la story monta un `Host` que crea los signals y pasa valores planos
  (`createSignal` + `<TasksToolbar view={view()} onView={setView} …>`). Por eso los componentes se pueden
  montar sin provider ni router.
- Datos con `makeTask()` / `makeFilterTree()` de `data/fixtures.ts`, nunca JSX en `args`.
- Las stories que necesitan router (porque leen la URL o `useShell()`) se envuelven en `<StoryShell>`
  de `src/test-utils/StoryShell.tsx`, y el estado inicial se pasa por `path` (`"/tasks?view=kanban"`). Eso
  reemplaza a los viejos `initialTree`/valores iniciales inventados sólo para stories.

### `play`: los tres errores que cuestan una hora

**1. Toda aserción de DOM va dentro de `waitFor`.**

`userEvent` usa eventos de entrada reales por CDP: el handler corre en una tarea del renderer que puede
ejecutarse **después** de que la promesa del click se resuelve. El click funciona y la aserción mira el DOM
antes de que Solid aplique el cambio.

```tsx
await userEvent.click(sidebarItem("Tasks"));
await waitFor(() => expect(document.querySelector('[data-testid="tasks-toolbar"]')).not.toBeNull());
// y si hay dos aserciones, las dos adentro: no alcanza con que la primera espere
```

**2. Los `globals` de una story se filtran a las siguientes.**

En el corredor de tests, no en la UI. Medido: la misma story corre a 1440 sola y a **639** después de una
que declara `viewport: narrow`. Si tu story depende del ancho y viene después de una que lo cambia,
declaralo explícitamente en tu story.

**3. La URL también sobrevive entre stories.**

Una story que navega deja el hash puesto y la siguiente arranca ahí. Por eso `App.stories.tsx` tiene un
`loader` que llama a `resetStoryUrl("/")` antes de montar. Va en `loaders` y no en un decorador porque los
loaders corren **antes** de construir el árbol (y una story puede pisarlos, que es como `DeepLink` prueba un
link profundo).

El viewport por defecto del corredor, además, **no** es `initialGlobals.viewport`: si alguna opción de
viewport tiene `type: "mobile"`, esa gana. Por eso los tres (`narrow` 639, `compact` 1023, `wide` 1440) están
con `type: "other"`, que es lo honesto —son breakpoints de la app, no dispositivos.

## Tests

```bash
bun run test:run                                        # todo: ~10 s
bunx vitest run src/pages/TasksPage.stories.tsx         # un archivo
bunx vitest run -t "Tasks Flow"                         # por nombre
bunx vitest run --maxWorkers=1                           # si sospechás contención
```

Navegador **real** (Chromium), no jsdom, y no es un capricho: el DOM de este proyecto depende del layout. Los
menús portaleados se posicionan midiendo con `getBoundingClientRect` y el board cambia de lista a kanban
según `matchMedia`. jsdom no tiene layout (todo mide 0) ni `matchMedia`, así que los caminos que más se
rompen serían justo los que no se probarían. Playwright ya está instalado (`bunx playwright install chromium`
si falta el binario).

a11y corre en modo `error` con **todas** las reglas de axe por defecto, sin `runOnly`. Una violación rompe el
test. Si aparece una, se arregla el código, no se desactiva la regla: ya encontró dos bugs reales
(`aria-required-parent` en un scaffolding de story y `landmark-unique`, dos `<section>` con el mismo nombre
accesible en `SettingsPage`).

Helpers en `src/test-utils/story.ts`: `must()` (query que falla con mensaje en vez de `null!`), `surface()`,
`isSurfaceOpen()`, `sidebarItem()`.

## Ver la app de verdad

Para revisar layout real, capturas o interacción en la app (no en una story aislada), usá el skill
**ego-browser** contra el dev server. Recordá: `http://localhost:5173/` (escucha en IPv6) y los píxeles
dependen del tamaño de la ventana del daemon, así que fijalo con
`page.cdp("Emulation.setDeviceMetricsOverride", …)` si vas a comparar.

En los scripts del heredoc de ego-browser, **no declares `const click`/`page`/`task`**: el scope ya los tiene
y tira `SyntaxError: Identifier 'click' has already been declared`. Usá prefijos (`stepClick`).
