# ADR-056: Cobertura en Storybook y estrategia de verificacion

- Gate: `G-adr-dark-verification` · Deriva de: `G-darkmode-rfc` · Estado: aprobado
- Fecha: 2026-10-06

## Contexto

La suite corre 209 tests / 46 archivos / ~18 s en Chromium real (Storybook stories + `play` + axe en
modo `error`) y un project `unit` de Vitest. 28 de 37 stories envuelven el contenido en `bg-white`,
y `.storybook/preview.tsx` fija `backgrounds` con hex claros: en dark, esos wrappers taparian
cualquier bug. No hay mecanismo para correr una story en dos temas ni para verificar contraste.

La metodologia historica del repo (firma de color del DOM con `ego-browser`) no es reproducible
dentro de un worktree del runner (depende de instrumentos externos y de `dom/`, gitignored). El
review de ejecucion la rechazo como acceptance; se reemplaza por verificacion en la suite.

Ver RFC `.decisions/G-darkmode-rfc.md` §Propuesta 6 y §Resolucion de review (ejecucion).

## Decision

1. **Toolbar global de Storybook** en `ui/.storybook/preview.tsx`:
   `globalTypes.theme` con opciones `light | dark`, default `light`, y `initialGlobals.theme = "light"`.
   Un decorator (`.storybook/decorators.tsx`) aplica `document.documentElement.dataset.theme =
   context.globals.theme` antes de renderizar y limpia al desmontar. `backgrounds` se **desactiva**
   (los hex fijos del manager taparian el canvas del tema).
2. **Stories dark dedicadas** con `globals: { theme: "dark" }` para las vistas principales:
   Home, Tasks (lista y kanban), Task detail, Gates, Knowledges, Initiatives y Login. Son stories de
   pleno derecho: montan, corren `play` si corresponde y pasan por axe.
3. **Test de contraste e invariante del claro** en `ui/src/styles/theme-tokens.test.ts` (project
   browser, con `style.css` importado):
   - Setea `data-theme` en `<html>`, lee las custom properties con `getComputedStyle` y calcula
     ratios WCAG; restaura el atributo previo al terminar.
   - Umbrales dark: texto primario (`ink`, `ink-soft`, `muted`) ≥ 4.5:1 sobre `surface`, `canvas` y
     `raised`; `faint` ≥ 4.5 sobre `surface`/`subtle` y ≥ 3 sobre `chip`; cada `tone-*-ink` ≥ 4.5
     sobre su `*-bg` y sobre `surface`; `status-progress` y `status-backlog` ≥ 3:1 sobre `surface`;
     `on-strong/ink` ≥ 4.5.
   - Invariante del claro: los valores computados de los 30 tokens existentes en `data-theme="light"`
     son exactamente los hex actuales del archivo (lista literal en el test).
4. **Guard anti-regresion** `ui/scripts/check-colors.mjs` (Node, sin dependencias, ejecutable con
   `node`), expuesto como `"check:colors": "node scripts/check-colors.mjs"`:
   - Escanea `ui/src/**` y `ui/.storybook/**` buscando `bg-white`, `text-white`, `border-white`,
     `bg-black`, `text-black`, `rgb(`, `rgba(`, `hsl(` y valores arbitrarios `shadow-[...]` con color
     embebido, y hex `#rrggbb` fuera de allowlist.
   - Allowlist: `ui/src/styles/tokens.css`, `ui/.storybook/preview.tsx`, `ui/index.html`, y el
     propio script.
   - Falla con exit != 0 y reporta `archivo:linea: literal`.
5. **Documento de contrato de tema** `ui/docs/theme.md` (nombres de tokens, como agregar un token,
   como agregar un tema, precedencia, comandos de verificacion) y una referencia desde
   `ui/AGENTS.md`.
6. **Validacion visual final del orquestador** (fuera de las tasks): dev server + `ego-browser`,
   capturas en ambos temas de las 8 vistas, del control de tema y del logo.

## Consecuencias

- A favor: cada vista principal corre axe en ambos temas; el contraste queda fijado por test, no por
  ojo; el guard evita que vuelvan los literales.
- A favor: la verificacion es reproducible dentro de cualquier worktree del runner (solo `bun`).
- En contra / deuda: la verificacion visual pixel a pixel no es automated; la hace el orquestador al
  final. El manager de Storybook queda sin `backgrounds` (decision deliberada).

## Plan de implementacion

1. `.storybook/preview.tsx` + `.storybook/decorators.tsx`.
2. Stories dark de las vistas principales.
3. `ui/src/styles/theme-tokens.test.ts`.
4. `ui/scripts/check-colors.mjs` + script en `ui/package.json`.
5. `ui/docs/theme.md` + referencia en `ui/AGENTS.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — cada pieza tiene path, comando y criterion observable.

## Verificacion

- `cd ui && bun install --frozen-lockfile && bun run typecheck && bun run test:run` en verde,
  incluyendo las stories dark y `theme-tokens.test.ts`.
- `cd ui && bun run check:colors` sale 0 en el arbol migrado y sale != 0 si se reinserta un
  `bg-white` a proposito (se valida el guard).
- `bun run storybook` + toolbar `dark` muestra cualquier story en dark sin wrappers blancos.
