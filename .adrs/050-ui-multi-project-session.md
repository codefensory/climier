# ADR-050: índice multi-proyecto, sesión de navegador y retiro de settings/accounts

- Gate: `G-ui-adr-projects-session` · Deriva de: `G-ui-hosted-rfc` · Estado: borrador
- Fecha: 2026-10-05

## Contexto

El server aloja todos los proyectos pero no tiene forma de enumerarlos: el
catálogo deriva el directorio como `sha256(project_id)` y guarda ese hash en su
`.climier.json`, así que el id original no se puede recuperar enumerando. El
cliente trae un selector de proyecto ficticio (`All projects`, `Add new
project`) y una selección en memoria que no filtra datos, más rutas
`settings`/`account` que no son controles reales de Climier. Ver
`.decisions/G-ui-hosted-rfc.md`.

## Decisión

1. **Índice de proyectos en el catálogo**: el metadata del catálogo
   (`<dataRoot>/<sha256(id)>/.climier.json`) guarda además
   `source_project_id` (id original) y `name` opcional. `project_id` sigue
   siendo el hash y `assertMetadataIdentity` lo sigue validando.
   - `provisionProject()` escribe `source_project_id`.
   - `openProject()` hace un upgrade idempotente y atómico del metadata cuando
     falta `source_project_id` (primer acceso de proyectos legacy).
   - `listProjects()` enumera `dataRoot`, valida el metadata y devuelve solo
     entradas con `source_project_id` y directorio real. No inventa ids ni
     migra el DAG o el layout.
2. **Endpoint** `GET /v1/projects`: ruta top-level `/v1`, valida **bearer
   explícitamente** (no pasa por la autorización por proyecto existente) y el
   header de protocolo; devuelve `{ projects: [{ project_id, name|null,
   revision, node_count, updated_at }] }`. `name` es opcional; el cliente cae a
   `project_id`.
3. **Sesión de navegador**: login contra `POST /v1/auth/login`; token guardado
   en `localStorage` por origen; un cliente HTTP central agrega bearer + header
   de protocolo a todo request y al stream SSE. Login fallido (incluido rate
   limit) es reintentable; bearer inválido/expirado se limpia y vuelve al
   login; **logout visible**. No se agrega cookie auth ni CSRF.
4. **Project filter real**: la selección vive en la URL (`?project=<id>`),
   dispara recarga de snapshot + resubscripción SSE y filtra **todas** las
   vistas (tablero, gates, knowledge, initiatives, detalle). Se eliminan
   `All projects` y `Add new project`. Un cambio de proyecto descarta el estado
   anterior; nunca se mezclan datos.
5. **Estados explícitos**: catálogo vacío, `project_id` de URL inexistente,
   proyecto sin estado (`STATE_NOT_INITIALIZED`), cada uno con mensaje y
   siguiente paso; un proyecto inexistente detiene stream/reintentos.
6. **Retiro de settings/accounts**: se elimina `?panel=settings` y la ruta
   `/account` (y `SettingsPage`/`AccountPage` y sus items de navegación). La
   Home muestra métricas del proyecto seleccionado, no "Across your projects".
7. **`climier ui` local** no usa este catálogo: resuelve el proyecto del cwd con
   un adaptador loopback (ADR-047).

## Consecuencias

- A favor: multi-proyecto real con una sola fuente de identidad (el metadata
  del catálogo) y sin tocar el layout de datos.
- A favor: la UI deja de prometer cuentas/agregación que no existen.
- En contra / deuda: los proyectos nunca accedidos después de este cambio no
  aparecen en `listProjects()` hasta su primer acceso; es un límite explícito,
  documentado, sin ids inventados.
- En contra / deuda: hay una escritura pequeña de metadata en `openProject`
  para legacy; es idempotente, atómica y acotada al catálogo (no al DAG).
- En contra / deuda: el bearer en `localStorage` es aceptable para loopback +
  proxy TLS y password único; no es multi-usuario.
- En contra / deuda: la vista agregada queda fuera; requeriría una RFC propia.

## Plan de implementación

1. **Catálogo** — `src/server/catalog/index.mjs`,
   `src/server/runtime.mjs`, `test/server-catalog.test.mjs` (provision escribe
   `source_project_id`, upgrade legacy, `listProjects`, aislamiento).
2. **Endpoint proyectos** — `src/server/http.mjs` (o
   `src/server/http/projects.mjs`), `test/server/http/projects.test.mjs`
   (bearer obligatorio, protocolo, catálogo vacío, name opcional).
3. **Sesión cliente** — `ui/src/modules/core/...` o capa de datos del cliente:
   login/logout, storage, cliente HTTP central, gate de login; stories/tests.
4. **Project filter y vistas** — selector contra `/v1/projects`, URL, filtrado
   de todas las vistas, Home del proyecto, estados de error; retiro de
   settings/accounts.
5. **Ajuste E2E** — verificación con `ego-browser` de login, cambio de
   proyecto/URL, y estado sin proyecto.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — catálogo y endpoint son server-side con paths
  exclusivos; sesión y project filter son cliente; el retiro de settings/account
  comparte `ui/src` con la task de sesión, se mantiene en una sola task de
  cliente para no solapar paths.

## Verificación

- `node --test test/server-catalog.test.mjs`.
- `node --test test/server/http/projects.test.mjs` (sin bearer → 401; catálogo
  vacío → `[]`; name ausente → `null`).
- Cliente: login/logout, cambio de proyecto en URL, filtrado de vistas,
  ausencia de settings/account.
- E2E con `ego-browser` contra un server real con dos proyectos.
