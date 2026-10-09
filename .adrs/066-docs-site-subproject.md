# ADR-066: `docs/` como subproyecto Fumadocs + TanStack Start, fuentes canónicas y sistema visual desde `ui/`

- Gate: `G-adr066-docs-site-subproject` · Deriva de: `G-docs-public-site-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

`docs/` debe convertirse en un sitio real (índice, búsqueda, TOC, navegación) con Fumadocs + TanStack Start, pero `docs/reference.md` es un **artefacto publicado** (`package.json#files`) y está escaneado por `scripts/check-retired-surfaces.ts`; `docs/remote-server.md` lo lee `test/server-setup-docs.test.ts`. Un sitio React tampoco puede meter dependencias en el paquete raíz: la regla 1 de `AGENTS.md` solo exceptúa al subproyecto `ui/`. El usuario pidió además que el estilo visual esté inspirado en `ui/`. Contexto completo en `.decisions/G-docs-public-site-rfc.md`.

## Decisión

1. **`docs/` es un subproyecto autónomo**, espejo de `ui/`: `package.json`, `bun.lock`, `node_modules/`, `dist/` propios. El paquete raíz no gana dependencias de runtime. Se añade a `AGENTS.md` como segunda excepción a la regla 1.
2. **Stack:** Fumadocs (`fumadocs-core`/`fumadocs-ui` 16.x, `fumadocs-mdx` 15.x) sobre TanStack Start (`@tanstack/react-start` 1.x) con Vite y Tailwind CSS 4. La fuente de contenido es `fumadocs-mdx` con `source.config.ts` + `lib/source.ts` (no `@fumadocs/content-collections`).
3. **Fuentes canónicas intactas y single source:** `docs/reference.md`, `docs/PLUGINS.md` y `docs/remote-server.md` conservan **path y formato**; el sitio los ingiere con `docs/scripts/sync-canonical.mjs`, que copia cada archivo a una colección generada y gitignored añadiendo frontmatter. Un test de frescura regenera y compara, y falla si el generado está stale. Así `package.json#files`, `check-retired-surfaces.ts`, `test/package.test.ts` y `test/server-setup-docs.test.ts` no cambian.
4. **IA del sitio:** `index.mdx` + `getting-started/{install,quickstart,core-workflow}` + `concepts/{tasks,gates,knowledge,initiatives,edges-and-status,state-and-storage,lifecycle}` + `guides/{multi-agent,migration,troubleshooting}` + `reference/{cli,plugins,self-hosting,web-ui}`. Cada sección tiene su propio `meta.json`.
   `climier-ui.md` y `ui-redesign-plan.md` **no se publican**; se reemplazan por `reference/web-ui.mdx`. `agent-execution-flow.md` se reescribe en inglés como `concepts/lifecycle.mdx`. Idioma canónico: inglés.
5. **Sistema visual inspirado en `ui/`**, sin importar código de `ui/`:
   - **Tipografías:** DM Sans (`--font-sans`, texto) y Manrope (`--font-display`).
   - **Paleta:** los valores de `ui/src/styles/tokens.css` se mapean a las variables de Fumadocs:

     | Fumadocs (`--color-fd-*`) | Origen en `ui/` (light / dark) |
     |---|---|
     | `background` | `canvas` `#f6f6f6` / `#0e0e11` |
     | `foreground` | `ink` `#111111` / `#f2f2f2` |
     | `muted` | `subtle` `#f4f4f4` / `#232327` |
     | `muted-foreground` | `muted` `#737373` / `#a0a0a0` |
     | `card` / `popover` | `surface` `#ffffff` / `#18181b` |
     | `card-foreground` | `ink` |
     | `border` | `line` `#e6e6e6` / `#2c2c31` |
     | `primary` | `ink` `#111111` / `#f2f2f2` |
     | `primary-foreground` | `surface` `#ffffff` / `#0e0e11` |
     | `secondary` / `accent` | `subtle` `#f4f4f4` / `pressed` `#eaeaea` (dark `#232327` / `#2e2e33`) |
     | `ring` | `line-strong` `#d8d8d8` / `#3d3d43` |
     | `info` | `tone-blue-ink` `#60738d` / `#9fb2cd` |
     | `success` | `tone-green-ink` `#667557` / `#a9bf93` |
     | `warning` | `tone-amber-ink` `#8c6850` / `#d3a983` |
     | `error` | `tone-red-ink` `#a4473f` / `#e0998f` |

   - **Dark mode:** el sitio define los valores oscuros bajo `[data-theme="dark"], .dark`, para soportar tanto el atributo de `ui/` como la clase por defecto de Fumadocs; el tema por defecto es sistema, con `light`/`dark` seleccionables.
   - **Paridad:** un test parsea `ui/src/styles/tokens.css` y falla si la paleta central mapeada diverge. Divergencia intencional se documenta en el propio archivo de tema.
   - **Iconografía:** Hugeicons (`@hugeicons/core-free-icons`), mismo criterio de tamaño/stroke que `ui/AGENTS.md`.

## Consecuencias

- A favor: el contrato publicado y su verificación quedan intactos; un solo origen por documento; el sitio se ve y se siente parte de Climier.
- En contra / deuda: `docs/` mezcla tres `.md` canónicos con los directorios del sitio; el sync es un paso extra con riesgo de desincronización (mitigado por el test de frescura). La paridad de tokens es un mapeo manual (mitigado por test). Se aceptan dos stacks de frontend (Solid en `ui/`, React en `docs/`).

## Plan de implementación

1. **Scaffold del subproyecto** — archivos: `docs/package.json`, `docs/bun.lock`, `docs/vite.config.ts`, `docs/source.config.ts`, `docs/src/**` (root route, `docs/$.tsx`, `lib/source.ts`, `lib/layout.shared.tsx`, `components/mdx.tsx`, estilos), `docs/content/docs/index.mdx`, `docs/content/docs/meta.json`, `.gitignore`.
2. **Tema desde `ui/`** — archivos: `docs/src/styles/theme.css`, `docs/src/styles/theme-parity.test.ts`.
3. **Sync canónico** — archivos: `docs/scripts/sync-canonical.mjs`, `docs/scripts/sync-canonical.test.ts`, `docs/source.config.ts` (colección generada), `.gitignore`.
4. **Contenido** — archivos: `docs/content/docs/{getting-started,concepts,guides,reference}/**` (paths exclusivos por task).
5. **Wiring de repo** — archivos: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`; eliminar `docs/climier-ui.md`, `docs/ui-redesign-plan.md`, `docs/agent-execution-flow.md`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — scaffold (1) bloquea tema (2), sync (3) y contenido (4). Tema y sync pueden ir en paralelo tras el scaffold. El contenido se divide por sección con `meta.json` propio para no colisionar. El wiring (5) depende de que las páginas destino existan (4). Ambigüedad: `docs/reference.md` sigue sirviendo el link de README, así que el wiring solo cambia los links a `climier-ui.md`.

## Verificación

- `cd docs && bun install --frozen-lockfile && bun run typecheck && bun run build` en verde.
- `node --test docs/scripts/sync-canonical.test.ts` y `node --test docs/src/styles/theme-parity.test.ts` en verde.
- `bun run surface:check`, `node --test test/server-setup-docs.test.ts test/package.test.ts` en verde (contrato intacto).
- `bun pm pack --dry-run` sigue incluyendo `docs/reference.md` y **no** incluye `docs/src/**` ni `docs/node_modules/**`.
