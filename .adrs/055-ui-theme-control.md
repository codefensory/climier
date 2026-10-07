# ADR-055: Control de tema en la UI y variante dark del logo

- Gate: `G-adr-theme-control` · Deriva de: `G-darkmode-rfc` · Estado: aprobado
- Fecha: 2026-10-06

## Contexto

El runtime (ADR-054) expone `useTheme()`. Falta la superficie para que el usuario elija. El shell
(`AppShellContainer`) tiene dos zonas: el sidebar (`aside`), que en desktop colapsa a
`visibility:hidden` y en <=1023px es un drawer cerrado por default, y la barra de breadcrumb
(`.tasks-shell-breadcrumb`), siempre visible, donde ya vive `ShowSidebarButton`. El logo
(`climier-logo.png`, wordmark casi negro) es ilegible sobre el `surface` dark; su variante dark ya
esta generada (ADR-053).

Ver RFC `.decisions/G-darkmode-rfc.md` §Propuesta 5 y §Resolucion de review (producto).

## Decision

1. **Control en la barra de breadcrumb**, no en el footer del sidebar: es la unica zona siempre
   visible del shell. Se ubica junto a `ShowSidebarButton`, antes del estado de conexion.
2. **Componente `ThemeControl`** en `ui/src/modules/app-shell/components/ThemeControl.tsx`:
   - Boton icono (`Sun01Icon` / `Moon02Icon` / `MonitorDotIcon` de Hugeicons, 16px, peso de trazo
     `1.8`) con `aria-haspopup="menu"`, `aria-expanded` y `aria-label="Theme"`.
   - Menu con tres opciones `role="menuitemradio"` (`System`, `Light`, `Dark`), `aria-checked`
     segun `preference`, reutilizando el patron y las primitivas existentes (`PopoverSurface` +
     `MenuOption`); cierra con click afuera y con `Escape` como el menu de proyectos.
   - Al elegir, llama `setPreference` y cierra.
   - `prefers-reduced-motion` respetado (la transicion la aporta `[data-popup-surface]`, ya cubierta).
3. **Logo por tema**: en `AppShellContainer` el `<img>` usa
   `src={theme.resolved() === "dark" ? climierLogoDark : climierLogo}` con el mismo `alt="Climier"`.
   No se usa `<picture>` ni `prefers-color-scheme` porque el tema puede ser explicito.
4. **Zonas sin control**: `LoginPage` y `ProjectStatePage` (pre-auth / pre-proyecto) no llevan
   control; se estilizan para dark con los tokens y heredan el default `system`, que es justo el
   primer paint que importa.

## Consecuencias

- A favor: el tema se cambia en un click desde cualquier vista del shell, incluso con el sidebar
  colapsado o el drawer cerrado; el logo se lee en ambos temas.
- A favor: cero componentes nuevos de infraestructura; se reutiliza el patron de menu del proyecto.
- En contra / deuda: el control no existe en Login/ProjectState; es una decision explicita (esas
  pantallas no tienen shell). Si alguna vez se quiere ahi, el provider ya lo soporta.

## Plan de implementacion

1. `ui/src/modules/app-shell/components/ThemeControl.tsx` + story con `play` (abre el menu, elige
   `Dark`, verifica `document.documentElement.dataset.theme` y el `aria-checked`).
2. Enganchar `ThemeControl` y el `src` del logo en `AppShellContainer.tsx`.
3. Export en el `index.ts` del modulo si corresponde (exports explicitos, sin `export *`).

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija componente, ubicacion y criterio observable.

## Verificacion

- `cd ui && bun install --frozen-lockfile && bun run typecheck && bun run test:run` en verde.
- La story `play` comprueba el ciclo completo: click en el control -> opcion Dark ->
  `data-theme="dark"` -> `aria-checked="true"` en Dark.
- Captura manual con el sidebar colapsado: el control sigue visible en el breadcrumb.
