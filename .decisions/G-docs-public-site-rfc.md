# RFC: sitio de documentación público (Fumadocs + TanStack Start) y boundary público/interno

- Gate: `G-docs-public-site-rfc` · Iniciativa: `docs-site` · Estado: aprobado
- Autor: orchestrator · Fecha: 2026-10-09

## Problema

La documentación de Climier vive en `docs/` como seis archivos Markdown planos, sin índice, búsqueda, tabla de contenidos ni versionado, y con dos problemas concretos de contenido:

1. **Mezcla contrato de producto con material interno.** `reference.md`, `PLUGINS.md` y `remote-server.md` son contrato verificable por CI y, en el caso de `reference.md`, se publican en el tarball npm. En el mismo directorio conviven planes históricos en español (`climier-ui.md`, `ui-redesign-plan.md`, `agent-execution-flow.md`) que contienen contexto interno: `climier-ui.md` nombra un proyecto real (**Vegsport**), rutas privadas (`~/Dev/vegsport`) y observaciones de uso interno; `PLUGINS.md` referencia `.adrs` y `ADR-007/008/021/038`, y node ids internos (`T-plugin-v2-rfc-backlog`, `T-smoke`); `reference.md` usa node ids internos reales como ejemplo del contrato de commits (`T-re-installer`, `T-re-upgrade-command`).

2. **Ya es público sin curaduría.** El repositorio es público (`github.com/codefensory/climier`, `isPrivate: false`), así que `docs/`, `AGENTS.md`, `.adrs/`, `.decisions/`, `skills/` y `CLIMIER-CHEATSHEET.md` son legibles hoy. No hay credenciales filtradas (las menciones a secretos son guías de manejo), pero un **sitio de docs público e indexable** es una superficie distinta: se descubre y se comparte, y debe contener solo material de cara al usuario.

Se quiere construir un sitio de documentación con **Fumadocs + TanStack Start** que reemplace `docs/`, con estilo visual inspirado en `ui/`, y el sitio será público.

## Propuesta

Convertir `docs/` en un **subproyecto autónomo del sitio** (mismo patrón que `ui/`: `package.json`, `node_modules`, `dist` propios; el paquete raíz no gana dependencias de runtime) y separar el contenido en dos mundos con una frontera explícita:

```
docs/                              # subproyecto sitio (espeja ui/)
  reference.md                     # ← fuente canónica, path/consumidores intactos
  PLUGINS.md                       # ← fuente canónica, path/consumidores intactos
  remote-server.md                 # ← fuente canónica, path/consumidores intactos
  content/docs/                    # ← páginas autoradas del sitio (allowlist publicable)
    index.mdx
    getting-started/{install,quickstart,core-workflow}.mdx
    concepts/{tasks,gates,knowledge,initiatives,edges-and-status,state-and-storage,lifecycle}.mdx
    guides/{multi-agent,migration,troubleshooting}.mdx
    reference/{cli,plugins,self-hosting,web-ui}.mdx   # cli/plugins/self-hosting: generadas desde las canónicas
    meta.json
  src/                             # rutas TanStack Start + providers Fumadocs + tema
  scripts/{sync-canonical,mjs,check-public-docs.mjs}
  package.json · source.config.ts · vite.config.ts
```

Reglas de la propuesta:

1. **Allowlist, no denylist.** El build del sitio, el route handler y el índice de búsqueda leen solo el contenido público efectivo: `docs/content/docs/**` más los tres archivos canónicos sincronizados. Ningún archivo fuera de ahí es ruteable ni indexable.
2. **Single source para lo canónico.** `docs/reference.md`, `docs/PLUGINS.md` y `docs/remote-server.md` **se mantienen en su path y formato actuales**; el sitio los ingiere con un script de sync (`sync-canonical.mjs`) que añade frontmatter a un directorio de colección generado y gitignored, con un test de frescura. Cero churn en `package.json#files`, `scripts/check-retired-surfaces.ts`, `test/package.test.ts` y `test/server-setup-docs.test.ts`.
3. **Guardrail que falla cerrado.** `docs/scripts/check-public-docs.mjs` escanea el contenido público efectivo y aborta ante patrones cerrados (ver §Resoluciones de consolidación). Corre en `ci.yml` sin filtro de paths (escaneo puro de filesystem) y bloquea el deploy.
4. **Curaduría del contrato canónico.** Los tres archivos se **sanean** en su lugar: node ids genéricos en `reference.md`; quitar refs a `.adrs`/ADRs y al proceso interno de release en `PLUGINS.md`; quitar la sección "Live cutover from the retired wire" (runbook de mantenedor) y la invocación E2E en `remote-server.md`.
5. **Se descartan del sitio** `climier-ui.md` y `ui-redesign-plan.md`; el primero se reemplaza por un `reference/web-ui.mdx` de usuario escrito desde cero. `agent-execution-flow.md` se reescribe en inglés como `concepts/lifecycle.mdx`.
6. **Inglés canónico.** Sin i18n en v1; el material español que se conserve se traduce.
7. **Estilo visual inspirado en `ui/`.** Tokens climier mapeados a las variables de Fumadocs (`--color-fd-*`), tipografías DM Sans (texto) y Manrope (display), modo claro/oscuro, iconografía Hugeicons; detalle en ADR-066.

## Resoluciones de consolidación

Cierra las notas de review de `G-docs-public-site-rfc` (producto, arquitectura, ejecución).

- **Audiencia primaria.** El público primario son los **usuarios del CLI**: personas y agentes que coordinan trabajo con el DAG. v1 completa su recorrido end-to-end (instalación → primer proyecto/task → leer bloqueos y estado). Operadores de server y autores de plugins entran como referencia (`self-hosting`, `plugins`) sin reescritura profunda en v1.
- **Contrato del artefacto publicado.** Se **conserva** `docs/reference.md` como artefacto publicado y fuente canónica, y `PLUGINS.md`/`remote-server.md` en su path. El único cambio de consumidores es por los archivos que se eliminan. Sin cambio de formato ni de contrato npm.
- **Host, build y búsqueda.** Prerender estático (SSG) + búsqueda Orama estática en cliente + deploy a **GitHub Pages** (el repo ya está en GitHub, cero infraestructura nueva), con base path configurable para un dominio propio futuro. Deploy **dentro** de v1, porque el objetivo es publicar.
- **Visual.** Inspirado en `ui/`: mapeo hand-authored de los tokens de `ui/src/styles/tokens.css` a `--color-fd-*`, con un test de paridad que parsea el token file de `ui/` y falla si la paleta central diverge. No se importa código de `ui/` (subproyectos independientes) ni se mueve `tokens.css`.
- **Confidencialidad.** v1 se limita a la allowlist del sitio; **no** se extrae `AGENTS.md`/`.adrs/`/`.decisions/` del repo público. Es una decisión de proceso con alcance mayor y queda como gate/ADR follow-up, fuera de este RFC.
- **Guardrail automatizable** (reemplaza "cualquier nombre de cliente real"). Patrones que **deben fallar**: `vegsport`; IPs privadas (`\b(?:10|127)\.\d+\.\d+\.\d+\b`, `\b192\.168\.\d+\.\d+\b`, `\b100\.\d+\.\d+\.\d+\b`); `agento`, `ubuntu@`, `/home/ubuntu`; `ADR-\d+`, `\.adrs`, `\.decisions`, `\.pi/`, `\.agents/`, `AGENTS\.md`, `CLIMIER-CHEATSHEET`, `skills/`; node ids `\b(?:T|G|K)-(?:re|ui|pg|pf|rar|rb)-[a-z0-9-]+`; `CLIMIER_SERVER_PASSWORD`, `\.deploy\.env`, `server\.env` con valores. Patrones **permitidos** (fixtures que deben pasar): `T-example-*`, `T-auth-*`, `G-auth-*`, `alice`, `./my-project`. El guardrail incluye fixtures positivos y negativos.
- **Wiring de CI.** `check-public-docs.mjs` corre en `ci.yml` sin filtro de paths; `docs.yml` corre typecheck + build + prerender con paths `docs/**` y el propio workflow; el guardrail es gate de deploy en el ADR de hosting.
- **Orden del DAG.** gates de decisión (boundary, subproyecto+tema, hosting) → scaffold → guardrail → saneo canónico + verificación de consumidores → contenido por secciones con paths exclusivos → README/AGENTS/HELP_TEXT/CONTRIBUTING/SECURITY → búsqueda + deploy.
- **Docs de contribución.** `CONTRIBUTING.md` con el formato de commit genérico (`[TASK-ID]` opcional, sin node ids internos) y `SECURITY.md` con canal de reporte.

## Alternativas consideradas

### A. Stack del sitio

| Opción | Pros | Contras |
|---|---|---|
| **Fumadocs + TanStack Start (recomendada)** | Pedido del usuario; rutas tipadas, `source.ts` con search server listo; variante documentada y vigente (`fumadocs-core`/`fumadocs-ui` 16.16.2, `fumadocs-mdx` 15.4.6, `@tanstack/react-start` 1.168.60). | Stack React nuevo frente al `ui/` Solid; TanStack Start es joven. |
| Fumadocs + React Router o headless | Menos dependencia de TanStack Start. | Más ensamblaje manual; se aleja del pedido. |
| Starlight (Astro) | Docs estático maduro, soporta componentes React/Solid. | Introduce Astro como tercer stack; no es lo pedido. |

### B. Ubicación del sitio y del contrato publicado

| Opción | Pros | Contras |
|---|---|---|
| **`docs/` es el subproyecto y las canónicas quedan en su path; el sitio las ingiere (recomendada)** | Cero churn en CI/npm/scanner; una sola carpeta de docs; GitHub sigue renderizando los `.md`. | El root de `docs/` mezcla 3 `.md` con los directorios del sitio; el sync es un paso extra. |
| Mover las canónicas a `content/docs/**` como `.mdx` | Paths uniformes. | Cambia `files`, scanner, `test/package.test.ts`, `test/server-setup-docs.test.ts` y links de README; artefacto npm dentro de la estructura del sitio. |
| Dejar los `.md` canónicos donde están y crear `website/` | Cero churn. | `docs/` no se reemplaza; dos carpetas de documentación. |

### C. Deploy

| Opción | Pros | Contras |
|---|---|---|
| **GitHub Pages + SSG (recomendada)** | Cero infraestructura nueva; el repo ya está en GitHub; artefacto estático versionado. | Base path en project pages; requiere workflow de deploy. |
| Cloudflare/Netlify Pages | Dominio y previews mejores. | Cuenta externa y secretos por provisionar. |
| Servirlo desde `climier-server` | Reusa infra existente. | Acopla docs a un server experimental; no es estático. |

## Alcance

- **Dentro:**
  - Andamiaje Fumadocs + TanStack Start + Tailwind 4 con el tema derivado de `ui/`.
  - Saneo de `reference.md`, `PLUGINS.md`, `remote-server.md` en su path actual.
  - `sync-canonical.mjs` + test de frescura; `check-public-docs.mjs` + fixtures.
  - Redactar la IA del sitio (getting-started, concepts, guides, reference/web-ui).
  - `docs.yml` (build+prerender+deploy a GitHub Pages) y guardrail en `ci.yml` sin filtro.
  - Actualizar `README.md` (links a `climier-ui.md`/`ui-redesign-plan.md`), `AGENTS.md` (excepción a la regla 1 y refs a `docs/`), y `HELP_TEXT` si aplica.
  - Añadir `CONTRIBUTING.md` y `SECURITY.md`.
- **Fuera:**
  - Extraer `.adrs/`, `.decisions/`, `AGENTS.md`, `skills/`, `CLIMIER-CHEATSHEET.md` del repo público (gate follow-up).
  - i18n / documentación bilingüe.
  - Versionado de docs multi-release.
  - Cambiar el contrato CLI o el wire remoto.

## Riesgos y open questions

- **Frontera con el contrato publicado.** El scanner y los tests leen los `.md` en su path; se conservan, así que el riesgo se reduce a que el saneo toque una sección verificada. → test de regresión que corre `surface:check` y los tests de docs tras el saneo.
- **Sync puede desincronizarse.** → test de frescura que regenera y compara; CI falla si el generado está stale.
- **Paridad de tema con `ui/`.** → test que parsea `ui/src/styles/tokens.css` y compara la paleta central; divergencia intencional se documenta.
- **Coherencia de dark mode.** `ui/` usa `data-theme="dark"`; Fumadocs usa clase `.dark` por defecto. → bridge explícito en `source.config.ts`/root route, verificado en el build.
- **Base path de GitHub Pages.** Project pages sirven bajo `/<repo>/`. → `basePath` configurable y verificación de assets en el build estático.
- **Scope creep de contenido.** Acotar v1 al recorrido del usuario primario; ampliaciones en tasks separadas.
- **`CONTRIBUTING.md` / `SECURITY.md` inexistentes** hoy; su contenido debe evitar node ids internos y el formato de commits del repo (que es interno).

## ADRs derivados (se completa al aprobar)

- [x] ADR-065: boundary público/interno, publicación por allowlist y guardrail de CI → `.adrs/065-public-docs-boundary.md`
- [x] ADR-066: `docs/` como subproyecto Fumadocs + TanStack Start, fuentes canónicas y sistema visual desde `ui/` → `.adrs/066-docs-site-subproject.md`
- [x] ADR-067: hosting estático, build prerenderizado y búsqueda → `.adrs/067-docs-site-hosting.md`
- [ ] (diferido, fuera de este RFC) ADR-NNN: alcance de confidencialidad del material interno en el repo público
