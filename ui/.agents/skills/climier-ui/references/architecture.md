# Arquitectura

Un solo paquete, sin workspaces. `src/` tiene `App.tsx` (68 líneas), `index.tsx` (entry), `pages/` y
`modules/`.

## Capas

```
pages/  →  modules/tasks | modules/app-shell  →  modules/ui  →  modules/core
```

La flecha es la dirección de dependencia permitida. `ui` no conoce `tasks` (por eso `Chip` recibe
`background` y `color` como strings en vez de un `TaskLabelStyle`, y `PopoverSurface` nombra sus variantes
por ancho —`menuWide`, `menuNarrow`, `menuFit`, `panel`— y no por consumidor).

| Capa | Qué es | Qué NO es |
|---|---|---|
| `core` | infraestructura: `HugeIcon`, `types/hugeicon`, `utils/color` (`tint`), `breakpoints`, `primitives/useMediaQuery` | nada con semántica visual ni de dominio |
| `ui` | primitivas visuales: `Button`, `Chip`, `MenuOption`, `PopoverSurface` | nada que sepa de tareas, sidebar o páginas |
| `app-shell` | chrome: sidebar, breadcrumb, switcher de proyecto, frame, `navPaths` | páginas |
| `tasks` | el dominio de tareas: datos, tipos, componentes, controladores | chrome |
| `pages` | composición por vista + el registro `pages`/`workspaceRoutes` | lógica de UI reutilizable |

Un módulo de dominio **no** importa de `pages`. `pages` sí importa de `app-shell` (para `navPaths`) y de
`tasks`.

## Carpetas dentro de un módulo

| Carpeta | Qué va | Por qué |
|---|---|---|
| `components/` | componentes presentacionales con props planas | se pueden montar en una story sin provider |
| `containers/` | el único lugar donde se leen signals en un scope reactivo y se bajan como valores | en Solid la reactividad viaja en getters, no en el objeto de props |
| `controllers/` | lógica con estado que **no** devuelve JSX (`useTaskFilters`, `useTasksUrl`, `useShellController`) | separa el comportamiento del render |
| `providers/` | contexto + `useX()` que tira si falta el provider | el estado compartido no va en el módulo |
| `data/` | fixtures y tablas (`tasks`, `labels`, `statuses`, `sorting`, `filters`, `fixtures`, `navigation`, `projects`) | los valores válidos viven una sola vez |
| `types/` | tipos del módulo | |
| `utils/` | funciones puras (`taskGroups`, `sortedTasks`, `formatUpdatedAt`, `menuCoordinates`, `filterTreeParam`) | |

`data/fixtures.ts` es para stories: `makeTask()`, `makeCondition()`, `makeFilterTree()`. Son **funciones**,
no objetos compartidos: un objeto único que se mutara en un lado se vería en el otro, y JSX guardado en datos
no se puede reusar entre montajes (es un bug en Solid).

## Contratos

- **`index.ts` con exports explícitos.** Nunca `export *` (esconde lo que un módulo expone y arrastra
  dependencias), nunca re-exportar stories (las stories no son API). `data/fixtures.ts` no se exporta.
- **Nada de stores a nivel de módulo.** Un singleton filtra entre stories y las hace dependientes del orden.
- **Un token por valor** (`src/styles/tokens.css`), sin alias con `var()`. Tailwind v4 no hace tree-shaking
  de `@theme`, así que un alias no ahorra nada. Para alpha: `tint()` con `color-mix`.
- **JSX nunca en `args`** de una story, ni en `data/`. Si un dato necesita distinguir un dibujo, va un
  discriminante (`TaskGroupGlyph`) y el componente decide.
- **`class` primero en las primitivas.** En `Button`, la clase del llamador se antepone al `STATE_CLASS`: es
  layout, no estética (el trigger de filtros necesita `relative` para su badge).

## Estado

| Tipo | Dónde | Ejemplo |
|---|---|---|
| URL | rutas y search params | vista activa, `?panel=settings`, `view`/`sort`/`group`/`filter` |
| Provider | `ShellProvider` | sidebar colapsada, drawer, `activeItem`, proyecto |
| Local | `createSignal` | menú abierto, posición de popover, árbol de filtros en una story |

`useShellController` **deriva** `activeView` y `settingsOpen` de la URL, no los guarda: con señales propias
habría que sincronizar en los dos sentidos (click → signal → URL y URL → signal) y ahí es donde aparece el
estado que se desincroniza. Atrás/adelante y un link pegado a mano funcionan sin código extra porque no hay
nada que sincronizar.

El estado del board vive en la URL (`useTasksUrl`): vista, orden, agrupación y árbol de filtros. No hay
provider del board. Los defaults (`list`, `updated:desc`, `status`) **no** se escriben; un `null` en
`setSearchParams` borra la clave. Los cambios del board usan `replace: true`.

Consecuencia documentada: ninguno de los cuatro sobrevive a irse a otra vista y volver, porque el estado se
queda en la URL de `/tasks`. Si se quisiera que sobreviva, los links del sidebar tendrían que llevar el
search actual (decisión de producto, no limitación técnica).

### El árbol de filtros en la URL

`filterTreeParam.ts` lo serializa a JSON percent-encoded. Los `id` de cada fila **no** viajan (son internos)
y se regeneran al decodificar con el prefijo `url-`, distinto del `condition-N` que genera el contador, para
que una fila nueva no choque con una que vino en el link.

El decodificador **valida** campo y operador contra `filterFields` (si no, `fieldFor()` explotaría al
renderizar), descarta la condición inválida y devuelve el árbol vacío ante un JSON roto: la URL es entrada
de usuario.

## Agregar una vista

1. `navPaths` en `app-shell/data/navigation.ts` — única tabla de rutas (alimenta las `<Route>` y el sidebar).
2. `pages/index.ts`: entrada en `pages` con `fullBleed` si tiene contenido propio. `fullBleed` decide las
   clases del `<main>` (`tasks-main-content`, `pt-0`/`pb-7`) y si se aplica `max-w-[1100px]`.
3. `appNavigation` si va al sidebar. Lo que no está en la tabla cae en `PlaceholderPage`.

`App.tsx` arma las `<Route>` con `workspaceRoutes.map(...)` y el array tiene que quedar **plano**: el router
interpreta `children` como definiciones de ruta y las recorre sin aplanar (`asArray` en `createBranches`).

## Breakpoints

Conviven cuatro conjuntos y no coinciden entre sí: los de la app (`max-width: 639px` y `1023px`, en
`breakpoints.ts` y `style.css`), los de Tailwind (`sm` 640, `md` 768, `lg` 1024), y un `min-[900px]` suelto
en la toolbar. `sm` está a **1px** de 639. Si tu cambio depende del ancho, verificá en 639/1023/1440 y no
asumas que un breakpoint implica el otro.

El sidebar mide 248px fijo (hardcodeado en `AppShellContainer` y en `style.css`). `.main-content-frame` es el
contenedor real de `.main-content-view` (`position: absolute; inset: 44px 8px 8px`).
