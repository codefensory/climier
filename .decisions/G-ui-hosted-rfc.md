# RFC: reemplazar la UI experimental por climier-ui hosteada por el climier server

- Gate: `G-ui-hosted-rfc` · Iniciativa: `hosted-ui` · Estado: borrador | en review | aprobado
- Autor: orchestrator, con dirección del usuario · Fecha: 2026-10-05

## Problema

La UI actual vive en `ui/` como un subproyecto Express + Solid experimental.
Tiene defectos conocidos de contrato de lectura, polling cada 2 s de un snapshot
completo, sin URL real (routing local propio), sin tests de UI y un diseño ya
superado (ver `docs/ui-redesign-plan.md`).

En paralelo, `~/dev/climier-ui` es un rediseño completo del tablero (SolidJS +
Vite + Tailwind v4 + Storybook, con diseño, tokens, stories y tests de
accesibilidad) que **hoy consume un snapshot estático embebido**
(`realSnapshot.json`, ~4.7 MiB) y no tiene capa HTTP. Fue pensado como
proyección pura del estado de Climier, pero no está conectado a ninguna fuente
viva ni es accesible desde el server.

El usuario quiere una sola UI: la de `climier-ui`, servida por el climier
server, multi-proyecto (el proyecto es el filtro), con settings/accounts
desactivados y actualización del estado sin recargar la página. Debe reemplazar
por completo a la UI experimental.

## Propuesta

1. **Una sola UI.** `ui/` pasa a contener `climier-ui` como subproyecto
   autocontenido. Se elimina el servidor Express y su dependencia; el build
   (`ui/dist`) lo sirve el propio climier server.
2. **El server sirve la SPA y el API de UI en el mismo origen.** Se agrega un
   handler estático (Node stdlib) montado fuera de `/v1/*` con fallback SPA,
   cache de assets hasheados y path confinement. `/v1/*` no cambia.
3. **Contrato de lectura dedicado de UI.** Una proyección pura en
   `read-model/` produce el snapshot que ya consume el cliente
   (`ClimierSnapshot`), más detalle de nodo y actividad paginada. Los endpoints
   viven bajo `/v1/projects/:id/ui/*` y siguen autenticados con bearer + header
   de protocolo.
4. **Actualización en vivo por revisión.** Un stream SSE por proyecto emite
   solo cambios de `revision`; el cliente revalida el snapshot con `ETag`/
   `If-None-Match`. Sin recarga de página y sin re-descargar el snapshot
   completo si nada cambió.
5. **Multi-proyecto.** El catálogo del server persiste un índice
   `proyecto original → directorio interno`; un endpoint autenticado
   `GET /v1/projects` lo expone. La UI usa el proyecto como filtro de **todas**
   las vistas y persiste la selección en la URL.
6. **Sesión de navegador mínima.** Pantalla de login contra
   `POST /v1/auth/login`; el bearer se guarda por origen y viaja en cada
   request. Se retiran `?panel=settings` y `/account` de la UI, y se agrega un
   logout visible.
7. **`climier ui` deja de ser Express.** Se reimplementa como server local
   stdlib que monta el mismo handler estático y la misma proyección de UI, con
   un adaptador local loopback inyectado (no pasa por el catálogo remoto).

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| **A — Server sirve SPA + API de UI (recomendada)** | Un proceso, un origen (sin CORS), auth/header de protocolo ya existentes, `ui/dist` reutilizable, sin dependencias nuevas en el paquete | Hay que implementar static serving, SSE e índice de proyectos en el server stdlib |
| B — Mantener Express como proxy/estático al lado del server | Static/SSE fáciles con Express | Dos procesos y dos frameworks, `/v1` duplicado o proxied, deps runtime en el subproyecto, rompe el modelo "server = única superficie" |
| C — Server solo JSON; SPA aparte (CDN/proxy) con CORS | Independencia de deploy | Requiere CORS, exponer el bearer cross-origin, gestión de dos origins y proyectos |
| D — Cliente sigue con snapshot estático y se regenera por CLI | Mínimo cambio de cliente | No es viva, no es multi-proyecto, contradice el objetivo |
| E — WebSocket bidireccional | Bidireccional | No hay escrituras requeridas por ahora; sobre-ingeniería frente a SSE |

## Alcance

- Dentro:
  - Handler estático stdlib + fallback SPA + cache headers + path confinement.
  - Config opcional `uiRoot` en el server (default `<paquete>/ui/dist`,
    allowlist en `runtime-config.mjs`); si falta el build, `/` responde un aviso
    claro y `/v1/*` sigue funcionando. `package.json#files` incluye `ui/dist`.
  - Proyección pura de UI en `read-model/` (snapshot, detalle de nodo,
    actividad) y endpoints `/v1/projects/:id/ui/*` con límites de payload.
  - SSE `/ui/events` por revisión, watcher por proyecto y reconexión cliente.
  - `GET /v1/projects` (catálogo) con validación explícita de bearer y
    `listProjects()`/índice en el catálogo.
  - ETag por `revision`, `If-None-Match` → 304, compresión gzip/br.
  - Import de `climier-ui` a `ui/` desde un commit fijo, retiro de Express,
    rework de `climier ui`.
  - Cliente: capa HTTP, sesión/login/logout, project filter, store reactivo con
    SSE, migración de páginas y módulos de datos, estados de error.
  - Retiro de settings/accounts y de las opciones ficticias de proyecto
    (`All projects`, `Add new project`).
  - Verificación E2E con `ego-browser` sobre un server real con proyectos
    reales.
- Fuera:
  - Escrituras/mutaciones desde la UI (sigue read-only).
  - Vista agregada "todos los proyectos" (el filtro es un proyecto a la vez).
  - Cuentas de usuario, multi-usuario, cookies/CSRF, OAuth.
  - Cambios al wire Remote v1, al DAG, al ledger o a la semántica de auth.
  - TLS/proxy: siguen siendo operación del operador (`docs/remote-server.md`).

## Diseño de referencia

### Endpoints (bajo `/v1`, header `X-Climier-Protocol-Version: 1`)

```text
GET  /v1/projects                          -> { projects: [...] }   (bearer explícito)
GET  /v1/projects/:id/ui/snapshot          -> ClimierSnapshot (ETag: revision)
GET  /v1/projects/:id/ui/nodes/:nodeId     -> node detail contract
GET  /v1/projects/:id/ui/activity?limit&offset&action&agent&node&q
                                           -> { entries, total, limit, offset, facets }
GET  /v1/projects/:id/ui/events            -> text/event-stream (data: {"revision":N})
```

- `GET /v1/projects` no pasa por la autorización por proyecto existente: valida
  el bearer explícitamente antes de enumerar.
- La **forma** del snapshot es la de
  `ui/src/modules/tasks/data/climier/contract.ts`, y su dueño único es la
  proyección pura `read-model/` (probada con snapshots literales). El handler
  HTTP solo orquesta I/O; no reimplementa semántica ni copia lógica.
- `project` en el snapshot expone solo `{ id, name, revision, generated_at }`.
  No se exponen `root` ni `state_file` (son rutas locales); el cliente deja de
  requerirlos.
- `recent_activity` se limita server-side (50) y la lista completa se pagina
  por `/ui/activity`.
- Errores conservan el envelope `{ ok:false, error:{ code, message, details } }`.

### Índice de proyectos

Hoy `provisionProject(projectId)` deriva el directorio como
`sha256(project_id)` y el `.climier.json` del catálogo guarda el hash, no el id
original; enumerar directorios no puede recuperarlo. Decisión:

- El metadata del catálogo pasa a guardar también `source_project_id` (el id
  original del cliente) y `name` opcional; `project_id` sigue siendo el hash y
  `assertMetadataIdentity` lo sigue validando.
- `provisionProject()` escribe ese metadata con `source_project_id`.
- `openProject()` (que ya recibe el id original en cada request) hace un
  *upgrade* idempotente y atómico del metadata cuando falta `source_project_id`,
  de modo que los proyectos existentes se indexan en su primer acceso.
- `listProjects()` enumera el `dataRoot`, valida el metadata y devuelve solo
  entradas con `source_project_id`; los directorios sin índice se omiten (no se
  inventan ids). No hay migración del DAG ni del layout.
- `name` queda opcional: mientras no exista, la UI muestra el `project_id`.

### Ciclo de vida en vivo

1. El cliente carga la lista de proyectos y abre `ui/events` del proyecto
   activo (lectura por `fetch` streaming: `EventSource` no permite headers).
2. Al conectar y en cada `revision` distinta, revalida `/ui/snapshot` con
   `If-None-Match`. Un 304 no reemplaza el store.
3. El server detecta cambios con un watcher por proyecto: observa el
   **directorio** del proyecto (los commits renombran el ledger de forma
   atómica), re-resuelve el path vigente y usa un poll del ledger como
   comprobación autoritativa. Los watchers se comparten por proyecto y se
   cierran al desconectar el último SSE y al cerrar el server.
4. Emite solo cuando la revisión cambió; heartbeat periódico para mantener viva
   la conexión.
5. **Cliente resiliente:** si el stream cae, reconecta con backoff exponencial
   + jitter; mientras no hay stream, muestra estado *stale/offline* con última
   actualización y acción de reintento. Un stream caído nunca debe parecer
   "datos vivos congelados".

### Multi-proyecto en la UI

- El selector usa `GET /v1/projects`. Se eliminan las opciones ficticias
  `All projects` y `Add new project`.
- La selección vive en la URL (`?project=<id>`) y filtra **todas** las vistas
  (tablero, gates, knowledge, initiatives, detalle): al cambiar se recarga el
  snapshot y se resuscribe el SSE, y se descarta el estado del proyecto
  anterior (nunca se mezclan datos).
- La Home deja de mostrar métricas hard-coded "Across your projects" y pasa a
  mostrar métricas del proyecto seleccionado.
- Estados explícitos: catálogo vacío, `project_id` de URL inexistente,
  proyecto catalogado sin estado (`STATE_NOT_INITIALIZED`), cada uno con
  mensaje y siguiente paso; un proyecto inexistente detiene stream/reintentos.

### Sesión del navegador

- Login `POST /v1/auth/login` (sin bearer) → token.
- Token en `localStorage` por origen; el cliente central agrega bearer + header
  de protocolo a todo request y al stream SSE.
- Login fallido (incluido rate limit) muestra error reintentable; un bearer
  inválido/expirado se limpia y devuelve al login; hay un **logout visible**.
- No se agrega cookie auth ni el server cambia su contrato de auth.

### `climier ui` local

- Server HTTP stdlib local (loopback) que monta el handler estático y la
  proyección de UI, con un **adaptador local** que resuelve el proyecto del cwd
  y no requiere bearer (solo loopback). No se reutiliza el catálogo remoto ni
  la auth por bearer para el caso local. Sigue read-only y local-only.

### Import reproducible de climier-ui

- Origen fijo: repo `/home/yeferson/dev/climier-ui` en el commit `c2aa000`
  ("wip: current climier-ui state before integration").
- Se copian fuentes, config, `.storybook`, `scripts`, `docs`, `AGENTS.md`,
  `bun.lock`; se excluyen `.git`, `node_modules`, `dist`, `storybook-static`,
  `.ui-bridge`, `dom`, `.logs`, `*.png` de capturas.
- Toolchain: Bun fijado por `bun.lock`; verificación
  `bun install --frozen-lockfile && bun run typecheck && bun run build` y,
  cuando aplique, `bun run test:run` (usa Chromium del cache de Playwright ya
  presente en la máquina). Se documenta para CI/runner.

## Riesgos y open questions

- **EventSource no permite headers** → se consume el SSE con `fetch` +
  `ReadableStream`. Mitigación: parser SSE mínimo y testeable.
- **`fs.watch` poco confiable entre plataformas / renames atómicos** → debounce
  + watch del directorio + poll autoritativo del ledger; el stream nunca
  depende de que `fs.watch` dispare.
- **Snapshot grande (~4.7 MiB con 594 nodos)** → recorte de
  `recent_activity`, compresión gzip/br, ETag por revisión y cache por
  revisión del cuerpo comprimido. Proyección server-side evita recomputar todo
  en el browser.
- **Deps del subproyecto `ui/` en el runner/CI** → el root `npm test` no
  construye la UI; las tasks de UI usan Bun con `--frozen-lockfile` y
  verificaciones explícitas. Chromium ya está en el cache local de Playwright.
- **Índice de proyectos y proyectos legacy** → `source_project_id` se escribe al
  provisionar y se hace upgrade en el primer acceso; los proyectos no accedidos
  no aparecen hasta ese acceso. Se documenta como límite explícito, sin
  inventar ids.
- **Paquete npm `files`** → incluir `ui/dist`; el server degrada a aviso si
  falta el build.
- **Auth del navegador = password único compartido** → suficiente para loopback
  + proxy TLS; no se pretende multi-usuario. Deuda explícita.
- **Multi-proyecto agregado** → fuera de alcance; si hace falta, es una RFC
  posterior.
- **Riesgo de superficie retirada** → se retira `?panel=settings`, `/account`,
  `ui/server/server.mjs` y la dep `express`; actualizar
  `scripts/check-retired-surfaces.mjs`, `lint:cut`, README y docs si los
  referencian.

## Resolución de review

- `[review:arquitectura]` y `[review:producto]` y `[review:ejecucion]`
  bloquearon el descubrimiento de proyectos; resuelto con el índice
  `source_project_id` (sección *Índice de proyectos*) y con `GET /v1/projects`
  validando bearer explícito.
- `[review:ejecucion]` bloqueó la reproducibilidad del import; resuelto con
  commit fijo, exclusiones explícitas y Bun `--frozen-lockfile` (sección
  *Import reproducible*).
- `[review:producto]` bloqueó el project filter y la caída del stream; resuelto
  en *Multi-proyecto en la UI* y *Ciclo de vida en vivo* (reconexión con
  backoff, estado stale/offline, filtrado de todas las vistas, sin opciones
  ficticias).
- `[review:arquitectura]` preguntó por el dueño de la proyección, la exposición
  de rutas y el watcher; resuelto en *Endpoints* (dueño `read-model/`, sin
  `root`/`state_file`) y *Ciclo de vida en vivo*.
- `[review:producto]` preguntó por errores/labels/logout; resuelto en
  *Multi-proyecto en la UI* y *Sesión del navegador*.

## ADRs derivados

- [ ] ADR-047: Hosting de la SPA y reemplazo de la UI experimental → `.adrs/047-server-hosted-ui.md`
- [ ] ADR-048: Contrato de lectura de UI y proyección server-side → `.adrs/048-ui-read-contract.md`
- [ ] ADR-049: Actualización en vivo por revisión (SSE + ETag) → `.adrs/049-ui-live-revision.md`
- [ ] ADR-050: Índice multi-proyecto, sesión de navegador y retiro de settings/accounts → `.adrs/050-ui-multi-project-session.md`
