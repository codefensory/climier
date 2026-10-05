# Plan: Storybook + arquitectura por módulos en `climier-ui`

Estado: **Fases 0–8 completas**
Última actualización: Fase 8 verificada por 138 tests, y por 29 capturas de DOM con una única diferencia intencional (el estado del board ya no sobrevive a cambiar de vista)

Este documento es la guía operativa para introducir Storybook y reorganizar `src/` por módulos.
Las decisiones de arquitectura (estructura de carpetas, estado, reactividad) ya están tomadas y
se listan abajo como **restricciones**. El resto es el roadmap ejecutable.

## 0. Entregables

### Fase 0 — Storybook

Archivos nuevos:

```text
.storybook/main.ts        framework storybook-solidjs-vite + addons docs/a11y
.storybook/preview.tsx    import de style.css, layout fullscreen, backgrounds, 3 viewports
docs/plan-storybook.md    este documento
src/App.stories.tsx       stories Wide / Compact / Narrow
```

### Fase 1 — Tokens

```text
src/styles/tokens.css     31 tokens (nuevo)
src/styles/style.css      movido desde src/style.css
src/styles/icons.css      movido desde src/icons.css
```

### Fase 2 — `modules/core`

```text
src/modules/core/components/HugeIcon.tsx           (nuevo)
src/modules/core/components/HugeIcon.stories.tsx   (nuevo)
src/modules/core/types/hugeicon.ts                 (nuevo)
src/modules/core/utils/color.ts                    (nuevo)
src/modules/core/index.ts                          (nuevo)
```

### Fase 3 — `modules/app-shell`

```text
src/modules/core/breakpoints.ts                            (nuevo)
src/modules/core/primitives/useMediaQuery.ts               (nuevo)
src/modules/app-shell/                                     (nuevo, 12 archivos)
```

### Fase 4a — `modules/tasks`

```text
src/modules/tasks/                                         (nuevo, 42 archivos)
```

### Fase 4b — la toolbar partida

```text
src/modules/tasks/components/{TasksToolbar,TasksViewSwitch,SortMenu,GroupMenu,
                              FilterPanel,PopoverSurface}.tsx   (nuevos)
src/modules/tasks/containers/TaskBoardContainer.tsx             (nuevo)
src/modules/tasks/controllers/{usePopoverMenu,useTaskFilters}.ts (nuevos)
src/modules/tasks/utils/menuCoordinates.ts                      (nuevo)
```

### Fase 5 — `pages/` + `App.tsx` como composición

```text
src/pages/                                                      (nuevo, 8 archivos)
src/pages/*.stories.tsx                                         (nuevos, 6 archivos)
src/modules/tasks/providers/TasksBoardProvider.tsx              (nuevo)
```

### Fase 5.5 — capa de primitivas

```text
src/modules/ui/                                                 (nuevo, 5 archivos)
src/modules/ui/components/*.stories.tsx                         (nuevos, 4 archivos)
```

### Fase 6 — tsconfig y scripts

```text
tsconfig.storybook.json                                         (nuevo)
tsconfig.json · tsconfig.app.json · package.json                (modificados)
```

### Fase 7 — testing y a11y

```text
vitest.config.ts                                                (nuevo)
src/test-utils/story.ts                                         (nuevo)
15 stories                                                      onMount → play
.storybook/preview.tsx                                          a11y: error + viewports type other
```

### Fase 8 — router

```text
src/modules/app-shell/data/navigation.ts                        + navPaths · pathForView · viewForPath
src/modules/tasks/controllers/useTasksUrl.ts                    (nuevo)
src/modules/tasks/utils/filterTreeParam.ts                      (nuevo)
src/test-utils/StoryShell.tsx                                   (nuevo)
src/modules/tasks/providers/TasksBoardProvider.tsx              **borrado**
src/App.tsx · src/pages/index.ts · useShellController · TasksPage  (modificados)
```

Modificados en total:

```text
package.json              + scripts "storybook" y "build-storybook"
.gitignore                + storybook-static, *storybook.log
src/index.tsx             import "./style.css" → "./styles/style.css"
.storybook/preview.tsx    idem ruta
src/App.tsx               264 hex → tokens; hexToRgba → color-mix
bun.lock
```

Dependencias añadidas (devDependencies):

```bash
storybook@10.6.1  storybook-solidjs-vite@10.7.2
@storybook/addon-docs@10.6.1  @storybook/addon-a11y@10.6.1
```

Ninguna dependencia de runtime: los tokens son CSS puro.

`src/` no se tocó más allá de agregar el archivo de stories: la app sigue intacta.

---

## 1. Contexto

| Aspecto | Estado actual |
|---|---|
| Stack | SolidJS 1.9.5 + Vite 6 + Tailwind v4.3 + TS 5.7 |
| Gestor | Bun 1.4.2 · Node 26.8.2 |
| `src/` | `App.tsx` (929 líneas), `style.css` (252), `icons.css` (27), `index.tsx` (11), `assets/` |
| Componentes | **25** funciones, todas dentro de `App.tsx` |
| Exports | **1**: `export default function App()` (L709) |
| Colores | **28 hex distintos** inline (`#111111` ×61, `#737373` ×42) |
| Tailwind theme | Solo `--font-sans` y `--font-display`. Cero tokens de color |
| Testing | No existe. Sí hay `data-testid` abundantes y útiles como selectores |
| CI | No hay `.github/` |

**Conclusión:** no hay superficie que storyear. El trabajo real no es "instalar Storybook",
es **extraer componentes y tokens**. El wiring es trivial.

---

## 2. Restricciones ya decididas

### 2.1 Estructura de carpetas

Módulos de producto + una capa compartida explícita + routing fino.

```text
src/
├── modules/
│   ├── core/          iconos genéricos, primitives, utils puros, tipos, paleta
│   ├── app-shell/     chrome: sidebar, breadcrumb, drawer, layout
│   └── tasks/         dominio: kanban/list, filtros, sorting, estados
├── pages/
├── styles/
├── assets/
├── App.tsx
└── index.tsx
```

Forma interna de un módulo:

```text
modules/<feature>/
├── components/     presentacional puro, props planos   → storyeable
├── containers/     reads reactivos en scope tracked    → storyeable
├── controllers/    accessors + acciones, sin JSX       → testeable
├── providers/      contexto Solid (Provider)
├── data/           fixtures / seeds del módulo
├── utils/          helpers puros
├── types/
└── index.ts        única API pública
```

Reglas de la estructura:

- **No crear módulos especulativos.** Los que no existen (`blogs`, `courses`, `admin`, …) se crean
  cuando exista el feature, no antes. Hoy solo `core`, `app-shell`, `tasks`.
- **`layouts/` se elimina** → `app-shell` lo cubre.
- **`hooks/`, `services/`, `stores/`** se agregan cuando exista un consumidor real.
- **`StatusGlyph` y `PriorityGlyph` van a `tasks/`, no a `core`**: son vocabulario de dominio.
  `HugeIcon` y `NavIcon` sí son `core` (infra genérica).
- **`index.ts`**: exporta explícitamente, **nunca `export *`** (genera ciclos y rompe HMR con
  `vite-plugin-solid`). No re-exporta stories. Exporta cosas **reactivas o puras**, nunca valores
  derivados ya evaluados.
- **`containers/`** existe por una razón específica de Solid: es el único lugar donde los reads
  reactivos se hacen en scope tracked y se bajan como valores planos a `components/`.
  Regla: un contenedor se crea cuando la composición tiene **más de un consumidor**; si solo la
  usa una ruta, la hace `pages/`.
- **Fixtures cross-módulo** van a `core/fixtures/`. Es la única promoción anticipada a `core` que
  paga, porque Storybook es un consumidor real.

### 2.2 Estado: ninguna librería global

`nanostores` **no entra**. Existe para Astro islands (roots de hidratación independientes, sin
ancestro común → Context imposible). `climier-ui` es un SPA Solid de un solo root: Context funciona.

| Tipo de estado | Herramienta |
|---|---|
| Local UI (menú abierto, hover, posición) | `createSignal` en el componente |
| Cliente compartido (proyecto seleccionado, sidebar, vista) | `createStore` + **Context Provider** |
| Server state / fuente de la verdad | `@tanstack/solid-query` (o `createResource`) |

Anti-patrón: **no espejar server state en un store de cliente** (dos fuentes de verdad → bugs de sync).

**Prohibido el singleton de módulo** (`export const [x, setX] = createSignal()`): no tiene disposal,
no permite override, y **se filtra entre stories** dejando stories dependientes del orden.

Estado actual y destino:

| Estado | Naturaleza | Destino |
|---|---|---|
| `activeView`, `activeItem`, `settingsOpen` | navegación | router (URL) — futuro |
| `taskView`, `taskSort`, `taskGroup`, `filterTree` | estado de módulo | URL search params — futuro |
| `isCompact`, `isNarrow` | derivado de `matchMedia` | `useMediaQuery` en `core` |
| `sidebarCollapsed` | preferencia persistible | `localStorage` + store de `app-shell` |
| `projectsMenuOpen`, `drawerOpen`, `projectsMenuPosition` | efímero local | `createSignal`, se queda |
| **`selectedProject`** | **cross-módulo** | ✅ `createStore` + `ShellProvider` |

### 2.3 Contrato de componentes (Solid + Storybook)

Props **planos** en `components/`, para que Controls y Docs funcionen:

```tsx
// ❌ destructurar props rompe la reactividad (Solid 2 lo marca como warning)
const { title } = props;

// ❌ read fuera de scope tracked
const tasks = ctrl.visibleTasks();
return <TaskListRow task={tasks} />;

// ✅ el read ocurre en el JSX del padre → reactivo
return <TaskListRow task={ctrl.visibleTasks()} />;
```

Decoradores de Storybook que devuelven JSX **deben** usar `createJSXDecorator`
(si no, se duplican nodos DOM). `createDecorator` solo para side effects.

### 2.4 Gotchas de Storybook a respetar

- `import "../src/styles/style.css"` en `preview.tsx` es **obligatorio**: sin eso Tailwind no genera
  clases para las stories.
- `layout: "fullscreen"` por defecto: los menús usan `Portal` + `position: fixed` y leen
  `window.innerWidth/innerHeight`.
- Los breakpoints custom de la app (`639px`, `1023px`) **no coinciden** con los de Tailwind
  (`sm/md/lg`) → los viewports de Storybook deben replicarlos.
- `@storybook/addon-interactions` **no se instala** (está en el core desde SB9).
- `@storybook/addon-essentials` **tampoco** (SB9+ movió esas features al core).

---

## 3. Roadmap por fases

### Fase 0 — Storybook corriendo (sin tocar `src/`)

Objetivo: validar Vite + Tailwind v4 + fuentes + Hugeicons + docgen con **una sola story** del
`App` completo.

```bash
bun add -D storybook@10.6.1 storybook-solidjs-vite@10.7.2 \
  @storybook/addon-docs@10.6.1 @storybook/addon-a11y@10.6.1
```

`.storybook/main.ts` (ESM válido, SB10 lo exige):

```ts
import type { StorybookConfig } from "storybook-solidjs-vite";

const config: StorybookConfig = {
  framework: { name: "storybook-solidjs-vite" },
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
};
export default config;
```

`.storybook/preview.tsx`:

```tsx
import type { Preview } from "storybook-solidjs-vite";
import "../src/style.css"; // ← sin esto Tailwind no genera clases para las stories

const preview: Preview = {
  parameters: {
    layout: "fullscreen", // Portal + position: fixed leen window.innerWidth/innerHeight
    a11y: { test: "todo" },
    backgrounds: {
      options: {
        canvas:  { name: "canvas",  value: "#f6f6f6" },
        surface: { name: "surface", value: "#ffffff" },
      },
    },
    viewport: {
      options: {
        narrow:  { name: "narrow (≤639)",   styles: { width: "639px",  height: "900px" } },
        compact: { name: "compact (≤1023)", styles: { width: "1023px", height: "900px" } },
        wide:    { name: "wide",            styles: { width: "1440px", height: "900px" } },
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "surface" },
    viewport: { value: "wide" },
  },
};
export default preview;
```

`src/App.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import App from "./App";

const meta = { component: App, parameters: { layout: "fullscreen" } } satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = {};
export const Compact: Story = { globals: { viewport: { value: "compact" } } };
export const Narrow: Story = { globals: { viewport: { value: "narrow" } } };
```

**Aceptación:** `bunx storybook dev -p 6006` abre; sidebar de 248px, grilla de puntos visible,
fuentes DM Sans/Inter cargadas, Hugeicons renderizados, consola limpia.

#### Resultado — verificado en navegador

Todo lo anterior se comprobó con sondas DOM y capturas contra el dev server real:

| Comprobación | Resultado |
|---|---|
| `bun run build-storybook` | exit 0, 3 stories, `storybook-static/manifests/components.json` con snippets |
| `bunx tsc -b` y `bun run build` | pasan (la story no rompe el build de la app) |
| Sidebar | `width: 248px`, `position: static` en wide |
| Tipografía | `body` computa `"DM Sans", sans-serif`; cargadas DM Sans 400/500/600 + Inter 400/500/600 |
| Iconos | 28 `<svg>` con `viewBox="0 0 24 24"`, `stroke-width: 1.8px` |
| Grilla de puntos | `dashboard-layout` computa `radial-gradient(circle, #d9dee4 1px, …)` sobre `#f6f6f6` |
| Consola | `[]` — cero errores y cero warnings (colector inyectado vía `Page.addScriptToEvaluateOnNewDocument` antes del documento) |
| CSS | El bundle de Storybook y el de la app tienen el **mismo hash** (`CNKIvDIl`): Tailwind genera idéntico |
| Responsive 1023px | sidebar → `position: fixed` + `transform: translateX(-100%)`, aparece `app-sidebar-show`, toggle `aria-label="Close navigation"` |
| Responsive 639px | igual que 1023px (drawer) |
| a11y | El addon corre y ya reporta **Color contrast** (2 en wide, 1 en narrow) en modo `todo` |

#### Hallazgos que ajustan el plan

1. **Storybook solo aplica el *ancho* del viewport; el *alto* lo fija el panel.** Medido: `innerH`
   = 196px con el panel de addons abierto y 496px con el panel oculto, tanto con
   `layout: "fullscreen"` como con `"padded"` (descartado como causa). El `height: "900px"`
   del viewport **no** se aplica.
   → Consecuencia para la Fase 4: los menús de sort/group/filter calculan su posición con
   `window.innerHeight`, así que conviene **ocultar el panel de addons** (o usar una ventana alta)
   al verificar esas stories. No es un problema de la app, es del entorno de preview.
2. **Se quitó el glob `../src/**/*.mdx` de `main.ts`**: sin archivos MDX imprimía
   `No story files found for the specified pattern` en cada build. Re-agregar cuando existan docs MDX.
3. **La detección de Solid es automática.** El preset lee `solid-js` del proyecto (1.9.15) y
   resuelve el renderer legacy. No hay que configurar nada. Confirmado además que su `viteFinal`
   **no** duplica `solid()` si el proyecto ya lo tiene, así que `vite.config.ts` se hereda tal cual.
4. **Trampa para futuras aserciones en stories:** con el drawer cerrado,
   `getComputedStyle(sidebar).width` sigue devolviendo `248px`. Hay que asertar sobre
   `position` / `transform`, no sobre `width`.
5. **`backgrounds.default` no se usa**: `initialGlobals.backgrounds.value` es el que manda. Además la
   app pinta su propio `#f6f6f6` + puntos en `dashboard-layout`, así que el fondo de Storybook solo
   se ve donde la app no llega (en la práctica, casi nunca).
6. **`preview.tsx` debe importar `../src/style.css`** — confirmado como causa raíz: sin ese import
   Tailwind no genera ninguna utilidad para las stories.

---

### Fase 1 — Tokens de diseño

Sin esto, cada extracción reescribe colores a mano.

Se movió a `src/styles/`: `style.css`, `icons.css`, y se creó `tokens.css`.

`src/styles/tokens.css` — **31 tokens, uno por valor**. La lista completa está en el archivo; la
regla que lo gobierna es:

```css
/**
 * Regla: **un token por valor**. Si dos usos comparten el mismo hex, comparten el token;
 * el literal no se repite nunca. No hay alias con `var()`.
 */
@theme {
  /* Tipografía */
  --font-sans: "DM Sans", sans-serif;

  /* Texto */
  --color-ink: #111111;
  --color-muted: #737373;
  --color-faint: #8a8a8a;
  /* … superficies, líneas, tonos, status … */
}
```

**Dos tipos de consumidor, ambos funcionan:**

```tsx
// 1. clases Tailwind  →  text-ink, border-line, bg-canvas
<span class="text-ink border-line" />

// 2. CSS/JS en runtime  →  var(--color-…)
//    Necesario porque los atributos SVG y los style={{}} inline NO aceptan clases.
<path stroke="var(--color-status-progress)" />
style={{ "background-color": "var(--color-tone-green-bg)" }}
```

Por eso los tokens viven en `@theme`: generan utilidades **y** quedan como custom properties en `:root`.

#### Decisiones de la implementación

1. **Los status reutilizan el tono, no declaran token propio.** `ready`, `submitted`, `blocked` y
   `done` comparten valor con `faint`, `tone-blue-ink`, `tone-mauve-ink` y `tone-green-ink`.
   Declarar `--color-status-done: #667557` además de `--color-tone-green-ink: #667557` sería
   exactamente la duplicación que esta fase elimina. El mapeo status→token pertenece al módulo
   `tasks` (Fase 4), que es donde vive el vocabulario de dominio.
2. **`hexToRgba` se reemplazó por `color-mix`.** El helper troceaba el string hex en JS, así que no
   podía aceptar `var(--color-…)`. Ahora: `color-mix(in srgb, C N%, transparent)`.
   Verificado empíricamente que es **el mismo color**: `#667557 7%` →
   `color(srgb 0.4 0.458824 0.341176 / 0.07)` y `0.4×255=102`, `0.458824×255=117`, `0.341176×255=87`,
   que es exactamente el `rgba(102, 117, 87, 0.07)` anterior. Solo cambia la serialización.
3. **Tailwind no hace tree-shaking de estos tokens.** Era el riesgo principal: los que solo se usan
   vía `var()` desde JS (dentro de un string) no se detectan como clases. Comprobado que los 31
   se emiten en `:root`. Si en el futuro se agrega uno y desaparece, la solución es `@theme static`.
4. **`@theme` dentro de un archivo importado funciona.** `style.css` hace
   `@import "tailwindcss"; @import "./tokens.css";` y los tokens se registran igual.
5. **Las 2 de `.storybook/preview.tsx` quedan literales** (`#f6f6f6`, `#ffffff`): son configuración
   del manager de Storybook, que es otro documento y no carga nuestro CSS, así que `var()` no
   resolvería ahí. Es la única duplicación aceptada del repo.

#### Resultado — verificado

La aceptación no se revisó a ojo. Se capturó una **firma de color del DOM** de las 8 vistas
renderizadas (Home, Tasks lista, Tasks kanban, Knowledges, Gates, Initiatives, Account, Settings):
para cada elemento visible, en orden de documento, el valor computado de `color`,
`background-color`, los 4 bordes, `outline-color`, `fill`, `stroke` y `box-shadow`.

| Comprobación | Resultado |
|---|---|
| Firma antes vs después | **md5 idéntico** (`b46a9854…`), 1.155.023 bytes en ambos |
| Elementos / elementos pintados | idénticos en las 8 vistas |
| Tintes de `GroupHeader` (caso `color-mix`) | presentes en la firma y idénticos: `rgba(102,117,87,0.07)`, `rgba(192,138,62,0.07)`, … |
| `color(srgb …)` sin normalizar | 0 — la normalización convirtió todo a `rgba()` |
| Hex restantes en `src/` | **solo los 31 de `tokens.css`**; `App.tsx` y `style.css` en 0 |
| `bunx tsc -b` / `bun run build` / `bun run build-storybook` | los tres en verde |
| CSS de la app vs de Storybook | **md5 idéntico** (`5c171f90…`) |

La firma es independiente de los nombres de clase (que sí cambiaron, 264 sustituciones en
`App.tsx`), y normaliza la serialización para poder comparar `color-mix` contra `rgba`.

#### Hallazgo colateral

`activeView() === "Projects"` (L895 original) es **código muerto**: ningún `setActiveView` usa
`"Projects"`. Las vistas alcanzables son Home, Tasks, Knowledges, Gates, Initiatives, Account y el
panel Settings. Relevante para la Fase 5: extraer `ProjectsPage` sería extraer una página
inaccesible — conviene decidir si se conecta o se elimina.

**Aceptación:** `bun run build` pasa y la app se ve **idéntica**. ✅ Cumplida: 0 cambios visuales.

---

### Fase 2 — `modules/core` (piloto del patrón)

Objetivo: fijar la convención antes de escalar a `app-shell` y `tasks`.

Estructura resultante:

```text
src/modules/core/
├── components/HugeIcon.tsx          componente + story co-locada
├── components/HugeIcon.stories.tsx
├── types/hugeicon.ts                HugeIconAsset
├── utils/color.ts                   tint
└── index.ts                         export explícito, nunca export *
```

Cada componente con su **prop type exportado** — es lo que alimenta Controls y Docs:

```tsx
export type HugeIconProps = {
  icon: HugeIconAsset;   // asset de Hugeicons
  class: string;         // obligatorio: el tamaño lo decide quien consume
  strokeWidth?: string;  // por defecto 1.6
};
export function HugeIcon(props: HugeIconProps) { /* … */ }
```

#### Decisiones

1. **`NavIcon` se eliminó, no se movió.** `NavIcon` y `HugeIcon` eran **el mismo componente**
   salvo por dos defaults: `class="h-4 w-4"` vs `class` requerida, y `stroke-width` 1.8 vs 1.6.
   Moverlo a `core` habría duplicado el componente.
   Antes de unificar medí quién depende de cada default: de 24 usos de `HugeIcon`, **18 omiten
   `strokeWidth`** y por tanto dependen del 1.6. Así que el default del componente unificado se
   quedó en 1.6 y los 5 call sites de navegación pasan `strokeWidth="1.8"` explícito.
   Beneficio: el peso de trazo que pide `AGENTS.md` ahora es visible en el call site en vez de
   estar escondido en dos componentes distintos.
2. **`navIconAssets` se queda en `App.tsx`.** Es vocabulario de navegación, no infraestructura:
   moverlo a `core` sería meter datos de la app en la capa compartida. Baja a `app-shell` en la
   Fase 3. Se establece así la regla: **`core` no conoce datos de la aplicación**.
3. **`HugeIconAsset` se define de forma estructural.** El paquete declara `IconSvgObject` sin
   `export` en `dist/types/index.d.ts` y su mapa `exports` no expone el módulo de tipos, así que
   no se puede importar. Si el paquete cambiara la forma, `tsc` lo detecta en los call sites.
4. **`palette.ts` no se creó.** Se decidió en la Fase 1 que el mapeo status→token es vocabulario
   de dominio y pertenece a `tasks` (Fase 4), no a `core`.

#### Resultado — verificado

Como la fase solo mueve componentes, el DOM debe ser idéntico. Se comparó el `innerHTML` completo
de `#storybook-root` más la firma de color computado, en las mismas 8 vistas:

| Comprobación | Resultado |
|---|---|
| Nodos en el DOM | **5289 en ambos** |
| Elementos / svgs por vista | idénticos en las 8 vistas |
| Diff crudo | solo el **orden de atributos** del `<svg>`: `class` + `viewBox` vs `viewBox` + `class` |
| Diff normalizando el orden de atributos | **sha256 idéntico** (`37854c5f…`), 1.493.191 bytes en ambos |

Ese reordenamiento es consecuencia de que `class` pasó de estático a dinámico (`class={props.class}`),
que Solid aplica después de los atributos estáticos. No tiene ningún efecto: el orden de atributos
no influye en CSS ni en el render.

| Comprobación | Resultado |
|---|---|
| Stories nuevas | `Core/HugeIcon` con Default, Sizes, StrokeWeights y Grid — 7 stories en total |
| `Default` | 24×24, stroke 1.6 |
| `Sizes` | 25 svgs, 12→24px, stroke 1.8 |
| `Grid` / `StrokeWeights` | 25 svgs, strokes 1.2 / 1.4 / 1.6 / 1.8 / 2 |
| `bunx tsc -b` / `build` / `build-storybook` | los tres en verde |

**Aceptación:** `core/index.ts` exporta 1 componente + 1 util + 2 types; las stories renderizan;
`tsc -b` limpio. ✅ Cumplida.

---

### Fase 3 — `modules/app-shell`

**Hecho (3a y 3b).**

```text
src/modules/app-shell/
├── components/
│   ├── NavGlyph.tsx                 (nuevo: el wrapper se repetía 5 veces)
│   ├── ProjectIcon.tsx
│   ├── ShowSidebarButton.tsx
│   ├── SidebarControlIcon.tsx
│   ├── SidebarHeading.tsx
│   ├── SidebarRow.tsx
│   └── SidebarRow.stories.tsx
├── containers/AppShellContainer.tsx  (3b)
├── controllers/useShellController.ts (3b)
├── providers/ShellProvider.tsx       (3b)
├── data/
│   ├── navigation.ts                appNavigation, sections, navIconAssets
│   └── projects.ts
├── types/index.ts                   NavItem, NavSection, Project, NavIconAssets
└── index.ts
```

En `core` se agregaron dos piezas que el shell necesita y que también consume `tasks`:

```text
src/modules/core/breakpoints.ts            BREAKPOINTS.compact / .narrow
src/modules/core/primitives/useMediaQuery.ts
```

`App.tsx` queda reducido a esto más el contenido de las vistas:

```tsx
export default function App() {
  return (
    <ShellProvider>
      <AppShellContainer>
        <WorkspaceViews />
      </AppShellContainer>
    </ShellProvider>
  );
}
```

#### Decisiones

1. **`NavGlyph` se extrajo.** El wrapper `<span class="flex h-5 w-5 …"><HugeIcon … class="h-4 w-4" strokeWidth="1.8"/></span>`
   se repetía **5 veces** con texto idéntico. Ahora es un componente con tamaño fijo a propósito:
   no es un icono configurable, es *el* icono del sidebar.
2. **`useMediaQuery` va en `core` porque `isNarrow` lo consume `tasks`** (decide lista vs kanban),
   no sólo el shell. `BREAKPOINTS` documenta que **debe coincidir con los `@media` de `style.css`**:
   es la única duplicación CSS↔JS que no se puede evitar sin evaluar `getComputedStyle` en runtime.
3. **Storybook obligó a una decisión de API.** Con `icon` requerido y `StoryObj<typeof meta>`,
   Storybook exige que *cada* story declare todos los `args` requeridos, incluso las que sólo usan
   `render`. Las dos salidas eran (a) meter JSX en `args` —un elemento JSX en `args` se instancia
   una sola vez a nivel de módulo, y reutilizar ese nodo en dos montajes es un bug en Solid— o
   (b) hacer `icon` opcional. Se eligió (b). Los stories además se tipan contra `SidebarRowProps`
   y no contra `typeof meta`.
4. **`WorkspaceViews` es un componente, no JSX inline en `App`.** Los `children` se evalúan en el
   scope de quien los escribe, y `App` renderiza el `ShellProvider`: leer el contexto ahí sería
   leerlo fuera del provider. Es también el punto exacto donde entra `pages/` en la Fase 5.
5. **`shellHidden()` deduplica dos expresiones que estaban repetidas.** Los dos `<aside>`
   calculaban `aria-hidden` / `inert` con la misma lógica (`isCompact() ? !drawerOpen() : sidebarCollapsed()`)
   y sólo cambiaba el término de settings.
6. **`AppIcon` y `SidebarControlIcon` son SVG propios** y `AGENTS.md` pide Hugeicons salvo en el
   hexágono de status. No se tocaron porque reemplazarlos **cambia el render**, y esta fase es de
   extracción. `AppIcon` además sólo lo usa la vista `Projects`, que es código muerto (Fase 1).

#### Resultado — verificado

14 capturas: 8 vistas + 6 interacciones (seleccionar proyecto, colapsar/reabrir sidebar, abrir/cerrar
menú de proyectos, volver del panel de settings), incluyendo los portales fuera de `#storybook-root`.

| Comprobación | Resultado |
|---|---|
| Capturas | 14 — **2.435.043 bytes en ambos lados** |
| sha256 normalizando orden de atributos | **idéntico** (`9fbdbd4e…`) |
| Elementos / svgs / portales por captura | idénticos en las 14 |
| Selección de proyecto | `Atlas CRM Revamp` → `Helio Task System` cambia chip, breadcrumb y check del menú |
| `App.tsx` | 903 → **626 líneas** (788 tras la 3a) |
| Stories | `Core/HugeIcon` (4) + `AppShell/SidebarRow` (4) + `App` (3) = **11** |
| `tsc -b` / `build` / `build-storybook` | en verde |

#### Hallazgo: la asimetría de navegación es inalcanzable

En el controlador hay una asimetría que venía del original: los items de arriba (Home y Workspace)
**no** cierran el panel de settings, y los de abajo (Settings/Account) sí. Parecía un bug latente
(clickear Home con settings abierto dejaría settings abierto, y Home no se marcaría activo).

Lo comprobé empíricamente: **es inalcanzable**. Con el panel de settings abierto, el sidebar principal
queda `inert`, así que sus botones no reciben clicks. Se preserva tal cual y queda documentado en el
controlador para que nadie lo "arregle" creyendo que cambia algo.

> Sobre el **hover**: no es representable en una story estática —necesita puntero real— y no hay
> addon de pseudo-estados instalado. Se cubre en la Fase 7 con `play` + `userEvent.hover()`.

> Nota para la Fase 4: `isNarrow` se expone desde el controlador del shell, pero `tasks` debería
> llamar a `useMediaQuery(BREAKPOINTS.narrow)` por su cuenta en vez de depender del shell. Son el
> mismo valor y evita el acoplamiento entre módulos.

> Nota de arnés: el menú de proyectos abierto **se superpone geométricamente** al botón que lo abre
> (el menú arranca en `top: 152`, el trigger en `top: 104..144`), así que en los scripts de captura
> el orden de los pasos importa: hay que abrir/cerrar el menú en un estado limpio.

**Aceptación:** `SidebarRow.stories.tsx` cubre `nav`, `menu` + `expanded` y activo/inactivo. ✅
Cumplida salvo *hover*, que se difiere a la Fase 7 por una limitación real del entorno, no por omisión.

---

### Fase 4 — `modules/tasks`

**Hecho (4a): datos, tipos, componentes y stories. (4b): toolbar partida.**

```text
src/modules/tasks/
├── components/    StatusGlyph, PriorityGlyph, TaskCounts, TaskLabels, TaskMeta, TaskListRow,
│                  KanbanCard, GroupHeader, FilterOptionContent, TaskListView, TaskKanbanView
├── data/          statuses, labels, priorities, tasks, sorting, filters, fixtures
├── utils/         sortedTasks, taskGroups, formatUpdatedAt
├── types/
└── index.ts
```

Trabajos no triviales:

1. **`StatusGlyph` va a `tasks/`**, no a `core`: es vocabulario de dominio. `AGENTS.md` lo exceptúa de
   la regla de Hugeicons, y el comentario del archivo dice por qué (no hay equivalente con las 6
   variantes internas).
2. **Un solo mapa status → color (`STATUS_TOKENS`).** Antes estaba escrito dos veces, en el SVG del
   glyph y en `statusOrder`, con los mismos 6 valores. Ahora los dos leen de la tabla.

#### Decisiones

1. **El glyph de un grupo es un discriminante, no un `JSX.Element`.** `TaskGroupView.glyph` era JSX
   guardado en datos, y un elemento JSX se instancia **una vez**: reutilizar ese nodo en dos montajes
   es un bug en Solid, y por eso tampoco podía viajar por `args`. Ahora es
   `{ kind: "status" | "priority" | "label" | "all", … }` y el JSX lo arma `GroupGlyph`. Es lo que
   permite tener 8 stories de `GroupHeader` con Controls.
2. **Las vistas reciben `tasks` por prop.** `taskGroups()` leía el fixture del módulo, así que una
   story no podía mostrar un grupo vacío ni datos extremos sin tocar el fixture global. Ahora es
   `taskGroups(items, groupBy, sort)`.
3. **`TaskFieldOption<K>` unifica tres tipos idénticos.** `priorityLevels`, `sortFields` y
   `groupFields` declaraban cada uno `{ key; label; icon: typeof Task01Icon }`. El `icon` ahora es
   `HugeIconAsset` (el tipo estructural de `core`), así que los datos **no importan un icono suelto
   sólo para tiparse**.
4. **`priorityIcons` es un record total** sobre `TaskPriority`: el glyph de prioridad hacía
   `priorityLevels.find(…)!.icon`, y con el record no hay `find`, ni `!`, ni fallback inalcanzable.

#### El bug latente: probado, no supuesto

`TaskLabels` hacía `taskLabels[label].background`. Con un label fuera del mapa eso es leerle
`.background` a `undefined`. No era teórico: **lo reproduje con el código viejo y con el nuevo, mismo
fixture, mismo label `"Research"`**:

| | código viejo | `taskLabel()` |
|---|---|---|
| Filas renderizadas | **0** | **15** |
| DOM de `#storybook-root` | 51.017 B | 132.078 B |
| Chip `Research` | no existe | `--color-tone-green-bg` / `--color-tone-green-ink` |

La caída se lleva la **vista completa**, no el chip: el error ocurre dentro del `<For>` de los
grupos, así que no queda ninguna fila. `taskLabel()` mantiene la paleta curada y deriva un tono
**estable** (hash → uno de los 4) para lo desconocido, así que el mismo label se ve igual en
cualquier sesión y en cualquier máquina. `FilterOptionContent` usaba `?.` y no tiraba, pero quedaba
con fondo transparente; ahora resuelve igual que `TaskLabels`.

#### Resultado — verificado

24 capturas: 8 vistas + 16 interacciones, incluyendo los 3 menús portaleados de la toolbar y el panel
  de filtros con una fila agregada, el cambio de campo a `Labels` y el picker de valor.

| Comprobación | Resultado |
|---|---|
| Capturas | 24 — **6.709.233 bytes en ambos lados** |
| sha256 normalizando orden de atributos | **idéntico** (`a06df311…`) |
| Elementos / svgs / portales por captura | idénticos en las 24 |
| `App.tsx` | 626 → **381 líneas** |
| Stories | 11 → **59** (48 nuevas de `Tasks`) |
| Render de las 48 stories nuevas | todas OK, 0 errores |
| `tsc -b` / `build` / `build-storybook` | en verde |

Que el sha256 sea idéntico prueba tres cosas a la vez: la unificación de tokens no cambió ni un
color, el fix del crash no cambió nada sobre labels conocidos, y el glyph discriminante produce el
mismo DOM que el JSX en los datos.

#### Hallazgos de esta fase

1. **`TaskLabels` corta en 2 labels y no avisa.** Con los datos actuales es **inalcanzable** —ninguna
   tarea tiene más de 2— y por eso nunca se notó; con 3, la tercera desaparece en silencio. La story
   `MoreThanShown` lo deja a la vista. No se arregla acá porque un `+N` cambia el render y esta fase
   es de extracción. Además es inconsistente con el filtro, que **sí** muestra `+N` para varios
   valores: dos piezas del mismo módulo resuelven lo mismo de dos maneras.
2. **El progreso de un grupo es un promedio**, no una suma: un grupo con `[0, 100]` muestra 50%. El
   guardia `tasks.length ? … : 0` evita el `NaN` del grupo vacío. La story `EmptyGroup` lo cubre
   porque es el caso que se rompe en silencio.
3. **La tarjeta de kanban no clampa el título**, sólo la descripción (2 líneas). Un título de 3
   líneas estira la tarjeta y desalinea la columna contra sus vecinas; la fila de lista **sí**
   trunca el título. Queda como deuda, documentada en la story `LongContent`.
4. **`backlog` y `ready` usan tokens distintos pero se ven casi iguales** a 16px
   (`--color-status-backlog` vs `--color-faint`). No es un bug de código y no lo toco, pero la story
   `AllStatuses` lo hace evidente: son los dos únicos status que no se distinguen por color, sólo por
   el punteado.
5. **Storybook obligó a corregir mi propio detector de errores.** El texto del template de error
   vive dentro de un `<style>`, así que buscarlo en `textContent` daba **48 falsos positivos de 48**.
   Hay que excluir `style`/`script` y además mirar tamaño, porque el overlay de Storybook existe
   siempre en el DOM (dormido) — el mismo gotcha de la Fase 0.

#### Fase 4b — la toolbar, partida

```text
src/modules/tasks/
├── components/    TasksToolbar, TasksViewSwitch, SortMenu, GroupMenu, FilterPanel,
│                  PopoverSurface
├── containers/    TaskBoardContainer
├── controllers/   usePopoverMenu, useTaskFilters
└── utils/         menuCoordinates
```

##### Decisiones

1. **Un solo dueño del estado "qué menú está abierto".** Antes la regla "como máximo uno a la vez"
   estaba repartida: `toggleSortMenu` cerraba el filtro y el grupo, `toggleGroupMenu` cerraba los
   otros dos, `toggleFilter` cerraba los dos primeros. Tres funciones que tenían que estar de acuerdo
   entre sí, y agregar un cuarto menú rompía la regla. Ahora `TasksToolbar` tiene **un** signal y
   abrir uno cierra los otros por construcción. Como efecto secundario, `SortMenu` y `GroupMenu`
   quedaron sin estado propio de apertura (`isOpen` + `onOpen`/`onClose`) y se pueden montar sueltos.
2. **`usePopoverMenu` comparte sort y group.** Eran dos bloques de estado paralelos
   (`sortMenuOpen`/`sortMenuPosition`/`sortTrigger` y lo mismo para group) más dos ramas idénticas
   en cada uno de los tres listeners. Ahora la mecánica (posición, trigger, descarte) vive una vez.
   **No** es dueño de `isOpen`: eso lo tiene el padre.
3. **`PopoverSurface` deduplica un wrapper escrito cuatro veces.** Las clases de transición, más
   `data-popup-surface`, `data-open`, `aria-hidden`, `inert` y el `Portal`, estaban copiadas en el
   menú de sort, el de group, el de opciones y el panel. Una divergencia entre copias no se ve
   mirando: se ve cuando un menú deja de cerrarse.
4. **`useTaskFilters` acepta un `initialTree`.** La app siempre arranca con el árbol vacío; el
   parámetro existe para que una story pueda montar un panel con condiciones y subgrupos sin simular
   clicks, que es lo único que no se puede hacer con `args`. Mismo criterio que `SidebarRow.icon` en
   la Fase 3a.
5. **`isNarrow` ya no se lee del shell.** `TaskBoardContainer` llama a `useMediaQuery` por su cuenta,
   que era la deuda anotada en la Fase 3b: `tasks` ya no depende de `app-shell` para saber el ancho
   del viewport.
6. **El estado del board sigue en `App.tsx`** (`taskView`/`taskSort`/`taskGroup`). Se podría haber
   inventado un `TaskBoardProvider`, pero la Fase 5 los va a mover a `TasksPage` y la Fase 8 al
   router: montar un provider ahora sería maquinaria que se tira. `TasksToolbar` conserva la misma
   firma pública que tenía (`view`/`onView`/`sort`/`onSort`/`group`/`onGroup`), así que ese cambio no
   tocó `App.tsx`.

##### Hallazgo: cada `<Portal>` de Solid deja un `<div>` en el `<body>`

La primera corrida del arnés **falló**: `+2` elementos, `extras` 142→144, sha256 distinto. La causa
no era mía: el fuente de `solid-js/web` hace, en `Portal`,
`const container = createElement(props.isSVG ? "g" : "div", props.isSVG)` y mete el contenido ahí.
**Cada `<Portal>` crea un `<div>` contenedor.** El original tenía 2 Portales (uno con sort+group+panel,
uno anidado para el menú de opciones); partir la toolbar en cuatro componentes llevó eso a 4 Portales
→ 4 wrappers, o sea 2 de más.

Antes de aceptarlo verifiqué qué son: `<div>` **sin ningún atributo**, `0` de alto, `position: static`,
`transform: none`, `filter: none`, `contain: none`, `z-index: auto`. No crea containing block (los
hijos son `position: fixed` y siguen anclados al viewport) ni stacking context. Y como el resto tenía
que seguir siendo comparable, el arnés ahora extrae las `[data-popup-surface]` **sin** el wrapper del
framework y compara esas: comparar el contenedor sería comparar una decisión interna de Solid, no el
markup propio.

Existe una forma de volver a 2 wrappers exactos: subir todo el estado a un contenedor y que un
`TasksToolbar` puramente presentacional renderice los tres surfaces dentro de **un** `<Portal>`,
encadenando ~20 props. No lo hice: cambia un diseño mejor por un conteo de nodos.

##### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| Capturas | 24, **dos veces** (una con el arnés viejo, otra con el nuevo) |
| sha256 (app DOM + las 5 superficies, sin wrappers de Portal) | **idéntico** (`bb6dc367…`) |
| `rootEls` / `rootPainted` / `svgs` / `surfaces` por captura | idénticos en las 24 |
| `<body>` | 13 → **15** elementos: los 2 `<div>` de Portal, descritos arriba |
| `App.tsx` | 380 → **81 líneas** (929 al empezar el plan) |
| Stories | 59 → **101** (42 nuevas) |
| Render de las 90 stories de `Tasks` | todas OK (2 falsos positivos del detector, abajo) |
| Viewports | `wide` 1440 / `compact` 1023 / `narrow` 639 — exactos |
| Fallback a kanban | a 639px la vista es kanban **con el switch en List** |
| Breakpoint de 900px | las etiquetas Sort/Group/Filter se ocultan a 639 y se ven a 1023 |
| `tsc -b` / `build` / `build-storybook` | en verde |

##### Hallazgo menor: dos falsos positivos del detector

`PopoverSurface -- OpenMenu` y `-- Panel` reportaron error porque renderizan **sólo** la superficie, que
va al `Portal` fuera de `#storybook-root`: el detector marca error cuando el root queda con 0 hijos.
Verificado a mano: las tres variantes (abierta, cerrada, panel) renderizan bien. La cerrada queda en
`hidden opacity=0` y **5px más arriba** por el `-translate-y-[5px]`, que es exactamente lo que documenta la story. Es el mismo tipo de tropiezo que la Fase 4a: el detector de errores de Storybook es más
difícil de escribir bien de lo que parece, porque "no hay nodos" y "no renderizó" no son lo mismo.

**Aceptación:** matriz 6 × 5 ✅ · datos extremos ✅ · `progress` 0/50/100 ✅ · toolbar en los 3
viewports ✅ — **Fase 4 completa**.

> Recordatorio (ver hallazgo 1 de la Fase 0): al verificar los menús de sort/group/filter, ocultar
> el panel de addons para que `window.innerHeight` sea razonable. En `iframe.html` no hay panel de
> addons, así que las capturas de esta fase no lo necesitaron. **Pero los viewports sí necesitan el
> manager**: el addon los aplica desde ahí, así que `iframe.html` ignora los `globals` de viewport.

---

### Fase 5 — `pages/` + `App.tsx` como composición

**Hecho.** `App.tsx`: 81 → **68 líneas** (929 al empezar el plan).

```text
src/pages/                 (nuevo, 8 archivos + 6 de stories, 197 líneas)
├── index.ts               registro: activeView() → descriptor
├── HomePage.tsx
├── TasksPage.tsx
├── ProjectsPage.tsx
├── AccountPage.tsx
├── PlaceholderPage.tsx    Knowledges, Gates, Initiatives y vistas desconocidas
├── SettingsPage.tsx
└── PageAction.tsx         el botón de arriba a la derecha

src/modules/tasks/providers/TasksBoardProvider.tsx   (nuevo)
```

#### Primero se midió, después se movió

Esta fase mueve **dónde vive el estado**, y eso no se vería en un diff de DOM si el estado se resetea al
navegar — una captura por vista desde una carga limpia no puede distinguirlo. Así que antes de tocar nada
medí el comportamiento en el navegador. Con `Kanban` + `Priority` aplicados:

| Acción | Vista | Orden |
|---|---|---|
| Tasks → Kanban + Priority | Kanban | `Priority` (`text-ink`) |
| → Home → Tasks | **Kanban** | **`Priority`** |
| → Knowledges → Tasks | **Kanban** | **`Priority`** |
| → Settings → Back to app | **Kanban** | **`Priority`** |

El estado **sobrevive**, porque vivía en `WorkspaceViews`, que nunca se desmonta. Si los signals se mudaban
a `TasksPage` (que sí se desmonta al cambiar de vista), se reseteaban y eso es un cambio de comportamiento
real. Por eso hay un provider: es lo que pone el estado **arriba del punto donde se cambia de página**.

Y midiendo lo mismo para los filtros apareció una **asimetría**: una condición de filtro **no** sobrevive,
porque el árbol vive en `useTaskFilters` dentro de `TasksToolbar`, que sí se desmonta.

| | Antes de navegar | Después de Home → Tasks |
|---|---|---|
| Filas de filtro en el portal | 2 | **0** |
| Badge del panel | `2` | **sin badge** |

No se "arregló". Reproducirla era la condición para que la fase fuera verificable; y el arnés la captura
en las dos versiones, así que está probado que se comporta igual. El router (Fase 8) debería llevarse los
cuatro (vista, orden, grupo y filtros) al URL, y ahí se unifica.

#### Decisiones

1. **`TasksBoardProvider`, no signals en `TasksPage`.** Por lo medido arriba. Cuando entre el router se
   reemplaza por search params y las páginas casi no cambian: hoy `TasksPage` lee `useTasksBoard()` y baja
   valores planos.
2. **Los componentes siguen recibiendo props.** `TasksToolbar` y `TaskBoardContainer` podrían leer el
   provider, pero entonces sus stories necesitarían envolverlos y dejarían de mostrar sus estados con
   `args`. `TasksPage` es el contenedor: lee en un scope reactivo y baja.
3. **El frame no conoce nombres de vistas.** El registro mapea `activeView()` a un descriptor y el frame
   sólo pregunta `fullBleed`, que es lo que decide las cuatro clases del `<main>` (`tasks-main-content`,
   `pt-0`/`pb-7`) y la ausencia de `max-w-[1100px]`. Antes eso era `activeView() === "Tasks"` repetido
   cinco veces dentro del frame.
4. **`PageAction` en vez del ternario anidado.** La etiqueta del botón
   (`Projects` → "New project", `Account` → "Edit profile", el resto → "This week") era lógica de vista
   metida en el frame. Ahora cada página pasa la suya.
5. **`PlaceholderPage` en vez de tres archivos idénticos.** Knowledges, Gates e Initiatives se veían
   exactamente igual porque compartían el `fallback`. Una sola página deja visible que son la misma cosa.
6. **`ProjectsPage` se conserva aunque no sea alcanzable.** Borrar código muerto es una decisión aparte de
   una extracción, y su story es la única forma de verlo. Cuando se borre, se van los cuatro juntos: la
   página, la story, `AppIcon` y la entrada del registro.
7. **Los bloques se extrajeron verbatim** con un script sobre el `App.tsx` viejo (mismo método que la 4a),
   con la única transformación de reindentar. Reindentar es seguro porque Solid descarta los nodos de texto
   que son sólo espacios y contienen un salto de línea: la profundidad del fuente no llega al DOM.

#### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| Capturas | **28** (24 de la 4a + 4 nuevas de ida y vuelta), baseline y después |
| sha256 (app DOM + computed + portales) | **idéntico** (`2f3b8b53…`), **al primer intento y sin diferencias aceptadas** |
| `elements` / `painted` / `svgs` por captura | idénticos en las 28 |
| Tamaño de los dos archivos | 8.613.095 bytes, iguales |
| `App.tsx` | 81 → **68 líneas** |
| Stories | 101 → **118** (17 nuevas) |
| Render de las 17 stories de `Pages` | todas OK |
| `tsc -b` / `build` / `build-storybook` | en verde |

#### Hallazgos

1. **La asimetría de estado** (arriba): orden y grupo sobreviven, filtros no. Estaba desde el principio y
   nadie lo había decidido; se hizo visible al tener que elegir dónde poner cada cosa.
2. **Una clase que sólo existe en una story puede no estar generada todavía.** La story de `SettingsPage`
   usaba `min-h-[620px]` para darle alto al contenedor y la página salía aplastada (el `<main>` mide 58px
   en vez de 581): Tailwind **sí** genera la clase, pero el dev server había arrancado antes de que el
   archivo existiera y servía un escaneo viejo. Se arregló usando `.main-content-frame`, la clase real del
   proyecto — que además es la caja contenedora de verdad y no un número inventado.
3. **Cuatro juegos de breakpoints conviviendo.** Los de la app (639 / 1023, en `style.css`), los de
   Tailwind (`sm` 640, `md` 768, `lg` 1024) y el `min-[900px]` de las etiquetas de la toolbar. `sm` está a
   **1 píxel** de 639: a 639 el grid de Home tiene una columna y a 640 tiene dos. Y el alto de la lista no
   cambia, así que no se nota — es el tipo de cosa que sólo aparece si se mira a propósito.

**Aceptación:** `App.tsx` sin lógica de dominio ✅ · cada page con story de integración ✅

---

### Fase 5.5 — capa de primitivas (`modules/ui`)

**Hecho.** Insertada antes de la 6 porque la 6 y la 7 no tocan componentes, y porque la duplicación
estaba fresca: buena parte la había creado yo misma en la 4b.

```text
src/modules/ui/                        (nuevo, 5 archivos, 299 líneas)
├── index.ts
└── components/
    ├── Button.tsx              5 variantes + tabla de estados
    ├── Chip.tsx                la píldora de label
    ├── MenuOption.tsx          la fila de menú (slot + label + check)
    └── PopoverSurface.tsx      mudada desde tasks/, variantes renombradas
```

#### Por qué hizo falta, con números

No se decidió "hagamos un design system". Se midió la duplicación primero:

| Métrica | Antes | Después |
|---|---|---|
| Recetas de clases byte-idénticas repetidas en 2+ archivos | **27 usos en 11 recetas** | **0** |
| `<button>` escritos a mano fuera de `ui/` | 29 | **16** |
| Alturas distintas entre botones | 5 (h-6 … h-10) | 5 (sin cambio deliberado) |
| Radios distintos | 3 (6 / 8 / 10px) | 3 (sin cambio deliberado) |
| Archivos que repetían la fila de menú | 3, con 4 recetas cada uno | 0 |

The peor caso era la fila de menú: **cuatro copias en tres archivos**, cada una con su versión del slot
del check. Eso no era "componentes demasiado separados", era una abstracción que faltaba. La escribí en
la 4b cuando deduplicé el contenedor (`PopoverSurface`) y dejé las filas duplicadas adentro.

#### Lo que el primitivo NO hace, y por qué

1. **No normaliza la escala.** `ghost` mide 32px y `segment` 28px **hoy**, en el código original;
   `PageAction` y `Save` usan radios distintos del resto. Unificarlas es un cambio **visual**, no un
   refactor: hacerlo en la misma pasada habría vuelto imposible distinguir una regresión de una decisión.
   Lo que sí se ganó es que la escala quedó en **una sola tabla** (`VARIANT_CLASS` en `Button.tsx`) con una
   story delante, que es lo que hacía falta para decidirla después.
2. **No absorbe los tres botones sueltos del panel de filtros** (Add filter, Add group, Clear all): sus tres
   cadenas de clases son distintas entre sí (alto, tamaño de letra, `gap`), así que plegarlas también
   habría sido un cambio visual. Quedan propios y anotados.
3. **No absorbe las filas de navegación** (`SidebarRow` y las seis filas del sidebar). Cada una tiene una
   forma distinta y `SidebarRow` ya era un componente.

Neto: 13 de los 29 botones se plegaron en 2 primitivas. El +299 de `ui` compra 0 recetas duplicadas y 15
stories que documentan las variantes; el bundle de la app **bajó** de 123,17 kB a 121,65 kB.

#### Decisiones

1. **`ui` es un módulo hermano de `core`, no parte de él.** `core` es infraestructura (iconos, color,
   breakpoints, hooks): no tiene semántica visual. `ui` es lo contrario. Y la dirección de dependencias
   queda acíclica: `pages → tasks | app-shell → ui → core`. Antes no existía ese lugar, así que
   `SidebarRow` (en `app-shell`) y `PopoverSurface` (en `tasks`) eran primitivas inalcanzables para el otro
   dominio sin un import cruzado.
2. **`Button` no recibe `classList`, recibe `state`.** Con `classList` habría que apostar a en qué orden
   Solid aplica `class` y `classList` para reproducir la cadena. Se midió el DOM real: `class` primero y el
   estado **al final**. La tabla `STATE_CLASS` compone en ese orden explícito y el estado se nombra
   (`idle` / `open` / `applied` / `active`) en vez de inferirse de tres booleanos.
3. **`class` va primero en la cadena.** No es estilo, es layout: el disparador de filtros necesita
   `relative` porque adentro lleva el badge con la cuenta.
4. **`Chip` recibe `background` y `color` como strings.** Con un tipo del dominio (`TaskLabelStyle`)
   obligaría a `ui` a depender de `tasks`, que es exactamente lo que el módulo evita.
5. **`MenuOption` devuelve los dos extremos** (`leading` y `label`) en vez de recibir `option` y ramificar
   adentro: si no, el primitivo tendría que conocer `sortFields`, `groupFields` y `FilterOption` a la vez.
6. **Las variantes de `PopoverSurface` se renombraron por ancho** (`menuWide` / `menuNarrow` / `menuFit` /
   `panel`) en vez de por consumidor (`sort` / `group` / `option`). Un `ui` que conoce la palabra "sort"
   está mal ubicado; ese nombre era el único motivo por el que mudar el archivo requería pensarlo.

#### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| Capturas | **28**, comparadas contra la baseline de la Fase 5 |
| sha256 | **idéntico** (`2f3b8b53…`), 8.613.095 bytes en ambos |
| `elements` / `painted` / `svgs` por captura | idénticos en las 28 |
| Diferencia aceptada | **ninguna** (ver hallazgo 1) |
| Stories | 118 → **133** |
| Render de las 19 stories de `UI` | todas OK (2 falsos positivos conocidos del detector) |
| `tsc -b` / `build` / `build-storybook` | en verde |

#### Hallazgos

1. **Un atributo suelto de JSX no es lo mismo que un atributo con valor.** El primer intento **falló**, y
   por una razón real: `data-sort-trigger` suelto en JSX se renderiza como `data-sort-trigger=""`, pero al
   pasar por el `spread` de Solid se renderiza como `data-sort-trigger="true"` (un `true` booleano llega a
   `setAttribute` como la cadena `"true"`). Los selectores `[data-sort-trigger]` funcionan igual en los dos
   casos, así que era inocuo — pero es una diferencia real del DOM y no se aceptó: se pasa
   `data-sort-trigger=""` explícito y la captura quedó byte-idéntica.
2. **El normalizador de atributos funciona, pero su salida de diagnóstico engañaba.** El diff imprimía las
   líneas **sin** normalizar, así que dos líneas truncadas a 220 caracteres se veían iguales y no se veía
   *qué* atributo difería. Hubo que extraer los tags completos y compararlos atributo por atributo para
   encontrar el `""` vs `"true"`. Vale más arreglar la herramienta que confiar en que el ruido no importa.
3. **Mover una primitiva de dominio a `ui` puede requerir renombrar, no sólo mover.** `PopoverSurface`
   tenía las variantes nombradas por consumidor. Es el tipo de deuda que sólo se paga cuando el archivo
   cambia de dueño y queda a la vista.

**Aceptación:** 0 recetas de clases duplicadas ✅ · cada primitiva con story de sus variantes y estados ✅ ·
DOM byte-idéntico ✅

---

### Fase 6 — tsconfig y scripts

**Hecho.** Sin CI (no hay pipeline en este repo; los comandos quedan listos para el día que haya).

```text
tsconfig.storybook.json                                    (nuevo)
tsconfig.json            + referencia al proyecto de stories
tsconfig.app.json        + exclude de stories y test-utils
package.json             build → tsc -b tsconfig.app.json && vite build · typecheck → tsc -b
```

| Proyecto | Cubre |
|---|---|
| `tsconfig.app.json` | `src/` **menos** stories, tests y `test-utils` — lo que se empaqueta |
| `tsconfig.node.json` | `vite.config.ts` |
| `tsconfig.storybook.json` | `src/**/*.stories.*`, `src/test-utils/**`, `.storybook/**` |

#### Decisión: `build` no valida las stories, `typecheck` sí

El plan decía `build: "tsc -b && vite build"`, pero su propio criterio de aceptación pedía
"`bun run build` **no compila stories**" y "`bunx tsc -b` valida ambos projects" — con `tsc -b` en
`build`, una story rota rompería el build de producción, que es justo lo que el split evita. Quedó
`build: tsc -b tsconfig.app.json && vite build`, y `typecheck: tsc -b` para que exista **un** comando que
valide todo. En CI serían dos pasos: `typecheck` y después `build`.

#### Hallazgo: el split borró declaraciones ambientales

`bun run typecheck` falló en el primer intento:

```text
.storybook/preview.tsx(5,8): error TS2882: Cannot find module or type declarations for side-effect import of '../src/styles/style.css'.
src/modules/app-shell/containers/AppShellContainer.tsx(5,25): error TS2307: Cannot find module '../../../assets/climier-logo.png'
```

Las declaraciones de módulos CSS y de assets las aporta `vite/client`, y llegaban al programa de la app
por `src/vite-env.d.ts`. Al sacar las stories del programa, el proyecto de storybook quedó sin ellas. Se
arregló con `"types": ["vite/client"]` en `tsconfig.storybook.json`.

Nótese lo que esto **prueba**: el error del logo está en un archivo de la **app**
(`AppShellContainer.tsx`) y aun así `bun run build` salió verde — porque en el programa de la app ese
archivo sí tiene las declaraciones. Es la demostración de que los dos programas son independientes de
verdad.

#### Hallazgo: un archivo de configuración que ningún proyecto cubría

`vitest.config.ts` no estaba en ningún `include` (el de `tsconfig.node.json` era sólo `vite.config.ts`),
así que era código sin verificar. Al agregarlo apareció un error de tipos que llevaba ahí desde la Fase 7:

```text
vitest.config.ts(26,29): error TS2769: No overload matches this call.
```

`defineConfig(async () => ({ … }))` **funciona en runtime** pero no tipa: el `defineConfig` de
`vitest/config` no acepta la forma de función async. Se pasó a top-level await, que además es más claro
(el plugin se resuelve una vez). Vale como recordatorio: mientras el archivo no esté en un `include`, un
error de tipos de una configuración no lo ve nadie.

#### Que el split no baje el nivel

`tsconfig.storybook.json` repite `strict`, `noUnusedLocals` y `noUnusedParameters`. Verificado: un
`const sinUsar = 42;` en una story sigue dando `error TS6133`. Si el proyecto de stories hubiera quedado
con menos exigencia que el de la app, el split habría sido una pérdida.

#### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| `bun run typecheck` / `build` / `build-storybook` (árbol limpio) | verde |
| Error a propósito en `Button.stories.tsx` | `typecheck` **rojo** (lo nombra) · `build` **verde** |
| Error a propósito en `src/pages/AccountPage.tsx` | `build` **rojo** |
| `bunx tsc -b --dry` | lista los **3** proyectos |
| `noUnusedLocals` en una story | sigue mordiendo |

**Aceptación:** `bun run build` no compila stories ✅ · `bunx tsc -b` valida los tres projects ✅ ·
`bun run build-storybook` genera `storybook-static/` ✅

---

### Fase 7 — Testing y a11y

**Hecho.** `bun run test:run` → **135 tests, 29 archivos, ~9,5 s, verde en 3 corridas seguidas**.

```bash
bun add -D @storybook/addon-vitest@10.6.1 vitest@5.0.3 \
  @vitest/browser@5.0.3 @vitest/browser-playwright@5.0.3 playwright@1.63.0
bunx playwright install chromium        # 114 MB, una vez
```

```text
vitest.config.ts                     (nuevo) proyecto "storybook", chromium headless
src/test-utils/story.ts              (nuevo) helpers de las play
15 stories                          onMount + .click() → play + aserciones
.storybook/preview.tsx               a11y: test "todo" → "error"
```

#### Qué prueba cada cosa

Cada story es un test de humo: se monta y si tira una excepción, falla. Con 135 stories eso ya cubre
piezas de todas las capas. Lo que agrega de verdad son las **15 `play`**, que dejan de ser fotos y pasan a
ser tests de interacción con aserciones sobre el DOM.

Navegador real y no jsdom, porque el DOM de este proyecto **depende del layout**: los menús portaleados
calculan su posición con `getBoundingClientRect` y el board cambia de lista a kanban según `matchMedia`.
jsdom no tiene layout (todo mide 0) ni `matchMedia`, así que los caminos que más se rompen serían
justamente los que no se probarían.

a11y va en `error` con **todas las reglas de axe por defecto**, sin configurar `runOnly`: no hay ninguna
regla desactivada por conveniencia.

#### Hallazgo 1: encontró dos bugs reales, y un diff de DOM no podría

**En mi scaffolding de story.** `MenuOption` renderiza `role="option"`, y `option` necesita un `listbox`
como padre. Mis stories lo montaban dentro de un `<div>` pelado: 5 stories con `aria-required-parent`,
que es **WCAG 2 A (1.3.1)**, no una recomendación. Arreglado en el scaffolding (no en el componente: en
la app el padre lo pone `PopoverSurface`).

**En la app.** `SettingsPage` tenía dos `<section aria-label="Content panel">`: dos regiones con el mismo
nombre accesible, o sea la misma cosa dos veces para un lector de pantalla. `landmark-unique` es
*best-practice*, no WCAG, y aun así se arregló en vez de configurar la regla: un `<section>` sin nombre
accesible no es un landmark, y eso es lo correcto para un esqueleto de relleno. Cuando cada panel tenga
contenido de verdad le corresponde una etiqueta distinta o un `aria-labelledby`.

Vale la pena el detalle: **cinco fases de diff de DOM no podían verlo**. Un diff verifica que las cosas
sean *iguales*, no que estén *bien*. Este es el primer control del proyecto que no compara contra sí mismo.

#### Hallazgo 2: los eventos de entrada reales no son síncronos

La primera versión de las `play` falló, y no por el código:

```text
FAIL |storybook (chromium)| src/App.stories.tsx > Tasks Flow
AssertionError: expected null not to be null
```

`userEvent` usa los eventos de entrada reales del navegador (vía CDP), y el handler corre en una tarea del
renderer que puede ejecutarse **después** de que la promesa del click se resuelve. El click funcionaba; la
aserción miraba el DOM antes de que Solid aplicara el cambio. Regla que quedó: **toda aserción de DOM
posterior a una interacción va dentro de `waitFor`**. Está documentada en `src/test-utils/story.ts`, que es
donde vive `must()` y donde alguien va a buscarla.

#### Hallazgo 3: los `globals` de una story se filtran a las siguientes

En el corredor de tests, no en la UI. Medido sobre la misma story:

| Cómo se corre | `globals.viewport` | ancho |
|---|---|---|
| `vitest run -t "Tasks Flow"` | `{ value: "wide" }` | 1440 |
| `vitest run src/App.stories.tsx` (donde `Narrow` corre antes) | `{ value: "narrow" }` | **639** |

`Narrow` declara 639 y esa declaración **persiste** a `TasksFlow`, que venía después en el mismo archivo.
Como el board cambia a kanban por debajo de 639, el test fallaba esperando `tasks-list-view` con un
timeout de 1 s. Se arregla declarando el viewport en la story que lo necesita. Se probó y **no** funciona
ponerlo a nivel de `meta`: el default del meta no pisa un global ya filtrado.

#### Hallazgo 4: el viewport por defecto del corredor no es `initialGlobals.viewport`

Costó, y la causa apareció midiendo, no leyendo. Con los tres viewports con su `type` honesto
(`narrow: mobile`, `compact: tablet`, `wide: desktop`) y `initialGlobals.viewport: "wide"`, los 135 tests
corrían a **639** mientras la UI mostraba el mismo story a **1440**.

| Configuración | Tests | UI |
|---|---|---|
| `narrow` con `type: "mobile"` | 639 | 1440 |
| `narrow` con `type: "desktop"` | 1440 | 1440 |
| los tres con `type: "other"` | 1440 | 1440 |

Si entre las opciones hay una con `type: "mobile"`, esa pasa a ser el viewport por defecto del corredor e
ignora `initialGlobals`. Los tres quedaron con `type: "other"`, que además es lo honesto: no son
dispositivos, son los breakpoints de la app, y el `type` es sólo la etiqueta del desplegable. Los `globals`
explícitos por story siguen funcionando igual en los dos lados (1023 y 639 verificados).

#### Decisión: `SettingsPage` no usa `play`, y está bien

Su `onMount` llama a `selectBottomNavItem("Settings")`. Eso **no** simula una acción del usuario: siembra
el estado del shell, y no hay nada que clickear porque esa story monta la página sola, sin sidebar.
Convertirlo en `play` habría sido fingir una interacción. La interacción real —entrar a Settings desde el
sidebar— se prueba en `App.stories.tsx > SettingsFlow`, que verifica las dos mitades: el panel queda
visible **y** la vista de atrás queda `aria-hidden` + `inert`.

#### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| `bun run test:run` | **135/135**, 29 archivos, ~9,5 s, 3 corridas seguidas |
| Violaciones de a11y | **0**, con todas las reglas de axe por defecto |
| `onMount` + `.click()` restantes | 0 (los 15 pasaron a `play`) |
| Capturas de DOM | 29, comparadas contra la Fase 5.5 |
| Diferencia de DOM | **1 sola firma, 58 veces**: el `aria-label="Content panel"` quitado. Nada más |
| `tsc -b` / `build` / `build-storybook` | en verde |

La baseline de capturas pasa a ser esta: `/tmp/dom7-after.txt`, sha256 `0b775f7c…`. Es el **primer cambio
de render intencional** desde la Fase 1, y está justificado por accesibilidad: la etiqueta duplicada no
distinguía nada, así que sacarla no quita información.

**Aceptación:** `bun run test` verde ✅ · 0 violaciones a11y bloqueantes ✅ · las `play` son tests reales ✅

---

### Fase 8 — Router

**Hecho** (la mitad del plan que tenía trigger real: `@tanstack/solid-query` **no**, ver el final).

```bash
bun add @solidjs/router@1.0.0
```

```text
src/App.tsx                                    HashRouter + rutas derivadas + frame sin <Dynamic>
src/modules/app-shell/data/navigation.ts       navPaths · pathForView · viewForPath  (nuevo)
src/modules/app-shell/controllers/useShell…    activeView y settingsOpen derivados de la URL
src/pages/index.ts                             pageForPath + workspaceRoutes
src/modules/tasks/controllers/useTasksUrl.ts    (nuevo) el estado del board, en la URL
src/modules/tasks/utils/filterTreeParam.ts      (nuevo) ida y vuelta del árbol de filtros
src/modules/tasks/providers/TasksBoardProvider.tsx   **borrado**
src/test-utils/StoryShell.tsx                   (nuevo) router para las stories que lo necesitan
```

#### Decisión: `HashRouter` y no `Router`

Este repo **no tiene destino de despliegue**: no hay Dockerfile, ni nginx, ni config de host. El fallback a
`index.html` que sí existe es el de `climier/ui`, que es **otra** aplicación (boxicons, sin Storybook).
Con routing por history, un link profundo (`/tasks`) es un 404 en cualquier host estático sin ese fallback.

Además hay una razón específica de Storybook: `HashRouter` navega con `pushState` sobre una URL que sólo
cambia el hash (`#/tasks`), así que el iframe sigue siendo `iframe.html?id=…&viewMode=story#/tasks` y
recargar vuelve a la story. Con `Router`, la barra quedaría en `/tasks` y recargar daría 404 en el dev
server de Storybook — se rompería el recargar mientras se desarrolla.

Cambiar a paths reales el día que haya un host con fallback es cambiar `HashRouter` por `Router`.

#### Decisión: el panel de settings es un search param, no una ruta

`/settings` habría sido lo obvio y habría roto dos cosas que hoy funcionan: el panel **no es una página, es
una capa sobre una**, y la vista de atrás sigue montada (`aria-hidden` + `inert`). Con `/settings`, abrir
settings desde Tasks cambiaría la vista de atrás a la que corresponda a `/settings`, y "Back to app" llevaría
a Home en vez de a Tasks.

Va como `?panel=settings` sobre la vista actual, y eso además hace que la URL **reproduzca el estado
completo**: medido en el navegador, abrir `#/tasks?panel=settings` de cero deja Tasks atrás con el panel
encima, igual que haber clickeado.

`useSearchParams` es lo que lo hace posible sin pelear: su setter **fusiona** sobre el search actual y un
`null` **borra** la clave, así que el shell escribe `panel` sin pisar `view`/`sort`/`group`/`filter` y el
board escribe los suyos sin pisar `panel`.

#### Decisión: las rutas se derivan de `navPaths`

`navPaths` (en `app-shell/data/navigation.ts`) es la **única** tabla de rutas: de ahí salen las `<Route>` que
arma `App.tsx` y el `pathForView()` que usan los clicks del sidebar. Con los paths escritos en los dos
lugares, una vista nueva podía quedar navegable pero sin ruta (o al revés) sin que nada lo detectara.

Un detalle del router que se lee en su código y no en la doc: interpreta `children` como definiciones de ruta
y las recorre **sin aplanar** (`asArray` en `createBranches`), así que el array tiene que ser plano. Un
`.map()` dentro de otro array se leería como una ruta sin `path` ni componente.

Efecto lateral bueno: `Projects`, que estaba muerto (nada seteaba esa vista y su story era la única forma de
verlo), ahora tiene ruta y es alcanzable.

#### Decisión: los cuatro parámetros del board a la URL, y el provider desaparece

`TasksBoardProvider` existía por una razón que su propio comentario decía: era el lugar donde el estado del
board **sobrevivía al cambio de vista**. Ese es exactamente el trabajo de la URL, así que el provider se
borra en vez de convivir con ella. Una sola fuente de verdad, y además compartible.

Los defaults no se escriben (`list`, `updated:desc`, `status`): `/tasks` ya significa eso. Los cambios del
board usan `replace: true` — cambiar un filtro no es navegar, y con `push` el botón de atrás dejaría de salir
del board para convertirse en un deshacer de cada click.

#### Lo que llega en la URL es entrada de usuario

`#/tasks?filter=basura` tiene que mostrar un board vacío, no romper. El decodificador valida campo y operador
contra `filterFields` (si no, `fieldFor()` explotaría al renderizar), descarta la condición inválida y
devuelve el árbol vacío ante un JSON roto. Los `id` de cada fila **no viajan**: se regeneran al decodificar
con el prefijo `url-`, distinto del `condition-N` del contador, así que una fila agregada después de cargar un
link no puede chocar con una que vino en el link.

El árbol se serializa como JSON percent-encoded. Se lee peor en la barra de direcciones que un
`status.is.blocked,labels.has.bug`, pero los valores son texto libre (un label se llama `bug fix`) y un
formato lindo necesita reglas de escape — y una regla de escape mal escrita es un bug que sólo aparece con el
valor raro. Si estas URLs se vuelven documentos que la gente comparte a mano, ahí vale la pena el formato
lindo, con sus tests de escape.

#### El cambio de comportamiento, dicho fuerte

Antes: vista, orden y agrupación **sobrevivían** a irse a otra vista y volver; el árbol de filtros **no**.
Ahora: **ninguno de los cuatro sobrevive**, porque el estado del board se queda en la URL de `/tasks`.

Es coherente (los cuatro se comportan igual, que era el punto) y hace que una URL compartida siempre
reproduzca lo que se ve. Pero es un cambio real: alguien que tenía kanban, se iba a Home y volvía, ahora
vuelve en lista.

Si se quiere que sobreviva, el cambio es que los links del sidebar lleven el search actual
(`navigate(path + location.search)`). **No lo hice porque es una decisión de producto, no una limitación
técnica**, y tiene su costo: `/account?view=kanban&sort=priority:desc`, o sea parámetros del board pegados a
URLs de vistas que no tienen board.

#### Hallazgo: la URL también sobrevive entre stories

Es la **tercera** vez que aparece la misma clase de problema (viewport en la Fase 7, URL ahora): el estado que
vive fuera del árbol de componentes no se limpia entre stories. Medido: `Tasks Flow` navega a `#/tasks`, así
que la story siguiente arrancaba en Tasks creyendo arrancar en Home.

La solución es `resetStoryUrl()` en un `loader` del meta, y queda **verificado**: `SettingsFlow` corre justo
después de `TasksFlow` y su primera aserción es que el hash sea `#/`. Va en `loaders` y no en un decorador
porque los loaders corren antes de construir el árbol, y porque una story puede pisarlos — que es como
`DeepLink` prueba un link profundo.

#### Resultado — verificado

| Comprobación | Resultado |
|---|---|
| Capturas de DOM (29) | **1 bloque con diferencias**, `Vuelta-a-Tasks`, que es exactamente el cambio de arriba |
| Contenido de esa diferencia | Agrupación Priority → Status: 5 grupos → 6, +39 elementos. Nada más |
| `bun run test:run` | **138/138** (137 + `FilteredByUrl`) |
| `tsc -b` / `build` / `build-storybook` | en verde |
| Bundle | 121,65 kB → **137,13 kB** (+15,5 kB, el router) |

Verificado además en el navegador real, contra el dev server:

| Paso | Resultado |
|---|---|
| Click Tasks / Settings / Back to app / Account | `#/tasks` · `#/tasks?panel=settings` · `#/tasks` · `#/account` |
| `history.back()` y `forward()` | `#/tasks?panel=settings` y `#/tasks` |
| Deep link `#/tasks?panel=settings` recargado | panel abierto **y** Tasks montado atrás |
| Deep link `#/knowledges` · ruta inexistente | placeholder · placeholder |
| sort + group + filtro, recargando el link | los tres se reproducen: badge con la cuenta y la condición en el panel |
| Home y volver a Tasks | vuelve al default (el cambio de comportamiento) |

**Aceptación:** los cuatro parámetros sobreviven a recargar y se comparten ✅ · atrás/adelante funcionan ✅ ·
cada story arranca de una URL conocida ✅

#### Lo que NO se hizo: `@tanstack/solid-query`

El plan lo ataba a "agregás backend", y **no hay backend**: no hay endpoint, ni cliente HTTP, ni datos que no
sean fixtures. Instalarlo hoy sería un módulo especulativo — exactamente lo que las convenciones del proyecto
prohíben y lo que la Fase 5.5 evitó al no crear primitivas sin dos consumidores. La tabla del plan sigue
vigente: cuando haya backend, entra con `services/` + `controllers/` por módulo, y con el aviso de siempre
(la API v5 imita el adapter de React; si Solid 2 está en el roadmap, no casarse con patrones profundos).

---

### Fase 9 — Cuando toque (no ahora)

Los dos triggers que quedan:

| Trigger | Qué entra |
|---|---|
| Agregas backend | `@tanstack/solid-query` en `core` + `services/` + `controllers/` por módulo |
| Aparece Astro, vanilla o multi-framework | **Recién ahí** evaluar `nanostores` |

Aviso: `@tanstack/solid-query` v5 imita el adapter de React; hay un `v6-pre` que lo reescribe sobre
el modelo async nativo de Solid 2. Si Solid 2 está en el roadmap, no te cases con patrones
profundos de la API v5.

---

## 4. Resumen

| Fase | Alcance | Riesgo | Verificación |
|---|---|---|---|
| 0 | Storybook corriendo, 1 story | bajo | ✅ **hecho** — `bun run storybook` |
| 1 | Tokens | bajo | ✅ **hecho** — firma de color md5 idéntica en 8 vistas |
| 2 | `core` (piloto del patrón) | bajo | ✅ **hecho** — DOM sha256 idéntico en 8 vistas |
| 3 | `app-shell` | medio | ✅ **hecho** — sha256 idéntico en 14 capturas con interacciones |
| 4 | `tasks` | **alto** | ✅ **hecho** — 4a: sha256 idéntico en 24 capturas + 48 stories; 4b: idem + 42 stories más |
| 5 | `pages` + `App` delgado | medio | ✅ **hecho** — sha256 idéntico en 28 capturas (con ida y vuelta de navegación) + 17 stories |
| 5.5 | capa de primitivas `ui` | medio | ✅ **hecho** — 0 recetas duplicadas, sha256 idéntico, 133 stories |
| 6 | tsconfig + scripts | bajo | ✅ **hecho** — un error en una story deja el build verde y `typecheck` rojo |
| 7 | Vitest + a11y | medio | ✅ **hecho** — 135/135, 0 violaciones a11y, y encontró 2 bugs reales |
| 8 | Router | **alto** | ✅ **hecho** — URLs compartibles; 1 bloque de DOM cambiado a propósito; `solid-query` no entra sin backend |

Las fases 2→4 son mecánicas y siguen el mismo patrón, por lo que se pueden paralelizar **una vez que
la Fase 2 fije la convención**: prop types exportados, `index.ts` explícito, story co-locada.

---

## 5. Referencias

- `storybook-solidjs-vite` — https://github.com/solidjs-community/storybook
- Solid · Props — https://docs.solidjs.com/concepts/components/props
- Solid · Context — https://docs.solidjs.com/concepts/context
- Solid · Stores — https://docs.solidjs.com/concepts/stores
- Storybook · Vite builder (auto-fusiona `vite.config.ts`) — https://storybook.js.org/docs/builders/vite
- Storybook · Vitest addon — https://storybook.js.org/docs/writing-tests/integrations/vitest-addon
- AGENTS.md del repo — convenciones de iconografía (Hugeicons antes que SVG a mano)
