---
name: climier-ui
description: "Trabajar en el repo climier-ui (SolidJS + Vite + Tailwind v4 + Storybook): crear y modificar componentes, páginas y módulos, escribir o arreglar stories, correr la suite de Storybook (vitest + axe), y demostrar que un refactor no cambió el DOM renderizado. Usar cuando una tarea toque el código de este repo, su Storybook, sus tests, cuando pidan cambiar la UI de acá, sacar una captura de una story, o verificar que un cambio es visualmente inerte. Cubre el contrato de capas de módulos, las reglas de tokens e iconos, el modelo de estado en la URL, las convenciones de story y `play`, y el arnés de captura y comparación de DOM. Triggers: climier-ui, App.tsx, modules/core, modules/ui, modules/app-shell, modules/tasks, pages/, Storybook, story, play, vitest, axe, tokens, Hugeicons, refactor sin cambios, comparar DOM."
metadata:
  version: "1.0.0"
  date: "2026-10-03"
---

# climier-ui

Repo en `/home/yeferson/dev/climier-ui`. SolidJS + Vite + Tailwind v4 + Storybook 10, con Bun.
Antes de un cambio no trivial, leé `references/architecture.md` (dónde va cada cosa y qué contratos no se
rompen). Para escribir stories o correr tests, `references/storybook.md`. Para demostrar que un refactor no
cambió el render, `references/dom-harness.md`.

`docs/plan-storybook.md` es el registro de decisiones del proyecto: por qué cada cosa está donde está, con
las mediciones que lo justifican. Es largo y es **histórico**: vale como fuente para entender una decisión,
no como lista de tareas. `AGENTS.md` tiene las reglas de iconografía.

## Comandos

| Comando | Qué hace |
|---|---|
| `bun run dev` | App en `http://localhost:5173` |
| `bun run storybook` | Storybook en `http://127.0.0.1:6006` |
| `bun run test:run` | Toda la suite en Chromium real (humo + `play` + axe). ~10 s |
| `bun run typecheck` | `tsc -b`: los tres proyectos (app, node, storybook) |
| `bun run build` | Build de producción. **No** compila stories |
| `bun run build-storybook` | Storybook estático en `storybook-static/` |

`scripts/dev.sh start|stop|status` levanta o baja dev/Storybook y evita el problema de matar procesos por
nombre (ver la nota al final). `scripts/verify.sh` corre typecheck + tests + build de una.

### Levantar servidores sin romper la sesión

```bash
.agents/skills/climier-ui/scripts/dev.sh start both     # dev (5173) y storybook (6006)
.agents/skills/climier-ui/scripts/dev.sh status
.agents/skills/climier-ui/scripts/dev.sh stop both
```

**Nunca** uses `pkill -f "vite"` ni `pkill -f "storybook dev"`: el patrón también matchea el shell que lo
invoca y la sesión se mata a sí misma. Por eso el script mata por puerto, leyendo el pid de `ss`.

El dev server escucha en **IPv6** (`[::1]:5173`): usá `http://localhost:5173/`, no `127.0.0.1`, o vas a ver
`ERR_CONNECTION_REFUSED` con el server levantado.

## Antes de tocar: ¿el árbol se está moviendo?

Este repo suele tener **más de un agente trabajando a la vez** (el usuario corre otros agentes por Herdr).
Si vas a comparar capturas o a sacar conclusiones de un diff, primero comprobá que nadie esté editando:

```bash
find src .storybook -newermt '-10 minutes' -type f | head
```

Si aparece algo que no escribiste vos, esperá o preguntá: un árbol que cambia bajo los pies produce
"diferencias" que no son tuyas, capturas que comparan dos versiones distintas del código, y fallas
intermitentes que parecen bugs del arnés. Pasó: un `find` de 20 archivos editados en el último minuto
explicó tres fallas seguidas.

## El contrato que rompe el build si lo violás

- **Capas:** `pages → modules/{tasks,app-shell} → ui → core`. Un módulo de dominio **no** importa de `pages`.
  `core` es infraestructura sin semántica visual (iconos, color, breakpoints, `useMediaQuery`); `ui` son
  primitivas visuales sin vocabulario de dominio (`Button`, `Chip`, `MenuOption`, `PopoverSurface`).
- **`index.ts` de cada módulo: exports explícitos.** Nunca `export *`, nunca re-exportar stories.
- **Nada de stores a nivel de módulo.** El estado compartido va en un provider o en la URL. Un singleton de
  módulo filtra entre stories y las vuelve dependientes del orden de ejecución.
- **Un token por valor** en `src/styles/tokens.css`, sin alias con `var()`. Para transparencias, `tint()`
  (`color-mix`), no `hexToRgba`.
- **Iconos: Hugeicons**, import individual (`@hugeicons/core-free-icons/FooIcon`), renderizados con
  `HugeIcon`. Sólo la familia de hexágonos de estado es SVG a mano. Ver `AGENTS.md`.
- **No extraigas una primitiva con un solo consumidor.** La regla del proyecto es «≥2 consumidores reales»;
  un módulo especulativo es peor que la duplicación que evita.
- `strict` + `noUnusedLocals` + `noUnusedParameters` en los tres proyectos, stories incluidas.

## Cómo agregar una vista

1. Fila en `navPaths` (`src/modules/app-shell/data/navigation.ts`): es la **única** tabla de rutas, y de ahí
   salen las `<Route>` de `App.tsx` y los links del sidebar.
2. Si tiene contenido propio, una entrada en `pages` (`src/pages/index.ts`) con `fullBleed`. Si no, cae en
   `PlaceholderPage` sola.
3. Si va al sidebar, un item en `appNavigation`. `Settings` no es vista: es `?panel=settings`.

## Estado: dónde vive cada cosa

| Tipo | Dónde | Ejemplo |
|---|---|---|
| URL (compartible, sobrevive a recargar) | search params / rutas | vista activa, `?panel=settings`, `view`/`sort`/`group`/`filter` del board |
| Compartido en memoria | provider | sidebar, drawer, proyecto seleccionado |
| Local de un componente | `createSignal` | menú abierto, posición de un popover |

`useTasksUrl()` lee y escribe el estado del board en la URL; **no** hay provider del board (se borró al
entrar el router). Los defaults no se escriben en la URL, y los cambios del board usan `replace: true`
(cambiar un filtro no es navegar; con `push`, el botón de atrás se vuelve un deshacer de cada click).

## Verificar un cambio

Dos controles, para dos preguntas distintas:

1. **¿Funciona?** `bun run test:run`. Las stories con `play` son tests de interacción reales y axe corre en
   modo `error`: una violación de accesibilidad rompe el test. Si tocás UI, esto primero.
2. **¿Cambió algo que no debía?** El arnés de DOM: captura antes, cambia, captura después, compará los
   sha256. Detecta un `<div>` de más, una clase perdida o un token cambiado, que ninguna aserción ve.

```bash
DOM_OUT=dom/before.txt ego-browser < .agents/skills/climier-ui/scripts/dom-capture.mjs
# … cambiás el código …
DOM_OUT=dom/after.txt  ego-browser < .agents/skills/climier-ui/scripts/dom-capture.mjs
node .agents/skills/climier-ui/scripts/normdom.mjs dom/before.txt dom/after.txt
```

Sale `IDÉNTICO` o la lista de bloques con diferencias, con los tokens **normalizados** de los dos lados.
Cada diferencia tiene que ser intencional y estar explicada; si no lo es, es un bug del refactor. Las
capturas van a `dom/` en la raíz del repo (ignorado por git) y **no a `/tmp`**: `/tmp` se borra en cada
reinicio y ya se perdió una vez todo el arnés.

**Validá el arnés antes de confiar en un `IDÉNTICO`.** Un comparador roto dice `IDÉNTICO` para siempre y es
peor que no tenerlo. Meté una diferencia a propósito (cambiá una clase en el archivo de captura) y comprobá
que la reporta. Ver `references/dom-harness.md`: así se encontró que el filtro excluía la raíz de la app y
el arnés comparaba cuatro divs.

## Storybook sin perder tiempo

- **Mirá una story directo**, sin manager: `http://127.0.0.1:6006/iframe.html?id=<story-id>&viewMode=story`.
  Es lo que usan los scripts de captura y es lo más rápido para revisar un componente aislado.
- **Una story o un test a la vez**: `bunx vitest run src/pages/TasksPage.stories.tsx` o
  `bunx vitest run -t "Tasks Flow"`. La suite completa son 10 s, pero el ciclo corto es el que sirve.
- Las stories **son** los tests: cada story es un test de humo y las que tienen `play` son tests de
  interacción. No hace falta un archivo de tests aparte.
- Los tres errores que cuestan una hora, todos ya pagados varias veces: `waitFor` después de cada
  interacción, `type: "other"` en los viewports, y limpiar la URL entre stories. Están explicados en
  `references/storybook.md`; leelo antes de escribir una story nueva con `play`.
