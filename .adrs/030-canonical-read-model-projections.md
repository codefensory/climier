# ADR-030: proyecciones canónicas compartidas de lectura

- Gate: `G-remote-architecture-refactor-adr-030` · Deriva de: `G-remote-architecture-refactor-rfc` · Estado: borrador
- Fecha: 2026-09-26

## Contexto

CLI y servidor HTTP exponen vistas como status/context y lecturas de búsqueda, initiatives y log. Parte de las reglas derivadas se compone de forma paralela en los adapters, lo que abre la posibilidad de drift en filtros, blocking/readiness, knowledge, stale claims, alerts y formas de respuesta.

La propuesta completa y sus límites están en [RFC: consolidar arquitectura post remote-v1](../.decisions/G-remote-architecture-refactor-rfc.md), sección C. Los adapters pueden cargar un snapshot por un seam de lectura explícito; las reglas de proyección deben permanecer puras y fuera de CLI/HTTP.

## Decisión

1. Ampliar `src/read-model/` como único owner de las proyecciones públicas canónicas. No crear `application/queries/` en esta iniciativa salvo que aparezca una semántica independiente que justifique otra capa.
2. Añadir composiciones puras para status, context, search, initiatives y log. Como primera slice, extraer status y context; mantener parsing argv/query, carga del snapshot y envelopes en los adapters.
3. No reutilizar los nombres `projectStatus` ni `projectContext` para las vistas agregadas: `projectStatus` ya es un export compatible de bajo nivel (`statusOf`). Usar los nombres inequívocos `projectStatusView` / `projectContextView`, sin renombrar ni cambiar exports existentes.
4. Las proyecciones de status/context reciben una opción numérica `now` (epoch ms) obligatoria para cálculos temporales. El adapter la muestrea una sola vez por request y la pasa como valor; las funciones puras no llaman `Date.now()` ni aceptan callbacks de clock.
5. Cada vista define explícitamente su ámbito de consumers. Esta decisión canonicaliza las reglas de status/context de CLI y HTTP. `src/plugins/query.mjs` puede delegar los mismos subprojections puros solo donde shape y semántica coincidan; conserva `allowed_actions` basado en identidad explícita de query (sin policy/roles) y su DTO plugin. `ui/server/server.mjs` conserva su resumen/initiative summary y DTO UI; cualquier utilidad compartida (p. ej. conversión de claim time) debe ser pura y no cambiar que los stale alerts del UI solo consultan su campo actual. Search/initiatives/log canónicos abarcan CLI/HTTP, no amplían el DTO UI/plugin.
6. El projector context recibe la presencia/identidad `agent` como dato explícito opcional para derivar `allowed_actions`, sin importar policy/roles. Recibe un snapshot y un ID y devuelve la proyección cuando existe; ausencia de state/nodo se comunica de forma neutral por retorno tipado/resultado ausente acordado antes de migrar, y cada adapter conserva su error propio (CLI NODE_NOT_FOUND/state missing, HTTP 404/state-uninitialized, plugin contract).
7. Mantener todos los contratos actuales. No cambiar campos, filtros, orden, valores derivados, inclusiones por defecto ni error behavior como parte de una extracción. Compartir fixtures/snapshots y matrices de paridad; consultas HTTP reciben snapshot por el seam autorizado y no leen storage ni crean servidores.

## Consecuencias

- A favor: cada regla de lectura tiene un owner puro testeable sin filesystem ni reloj global.
- A favor: CLI y HTTP pueden contrastarse con la misma proyección para el mismo snapshot, mientras plugin/UI preservan sus contratos independientes.
- En contra / deuda: CLI y HTTP mantienen temporalmente parsing y envelopes propios, y la migración por vista genera una etapa de coexistencia.
- En contra / deuda: la inyección de clock requiere tocar firmas y pruebas aunque la política temporal observable no cambie.

## Plan de implementación

1. **Caracterizar contrato** — archivos: `src/read-model/index.mjs`, `src/cli/commands/{status,context}.mjs`, `src/server/http.mjs`, `src/plugins/query.mjs`, `ui/server/server.mjs`; tests `test/read-model.test.mjs`, `test/server-http.test.mjs`, `test/v2-context-contract.test.mjs`, `test/v2-status-history.test.mjs`, `test/plugin-api.test.mjs`, `test/ui-live.test.mjs`. Deliverable verificable: una matriz/fixture por vista que congele filtros/defaults, orden, campos, identidad y umbral temporal (stale/age), comparada contra el comportamiento actual de CLI y HTTP. Plugin/UI se contrastan solo como regresión y no capturan la forma canónica.
2. **Proyección status/context CLI/HTTP** — archivos: `src/read-model/`, `src/cli/commands/{status,context}.mjs`, `src/server/http.mjs`, tests pure/CLI/HTTP indicados. Añadir nombres de vista sin reemplazar `projectStatus`; inyectar `now` epoch-ms muestreado una vez por request; añadir resultado neutral para nodo ausente y dejar que adapters mapeen sus errores. Esta slice debe completarse y quedar aceptada antes de abrir las vistas siguientes; un worker a la vez sobre `src/read-model/` y `src/server/http.mjs`.
3. **Delegación de subprojections en plugin** — solo para reglas con semántica idéntica — archivos: `src/plugins/query.mjs`, `test/plugin-api.test.mjs`. Plugin conserva sus DTOs, identidad runtime como input explícito y errores públicos; `allowed_actions` permanece una proyección plugin sobre reglas puras compartidas, no importa policy. Depende de que la slice 2 esté aceptada.
4. **Proyecciones restantes CLI/HTTP** — una vista a la vez, después de aceptar las slices 1–3 — archivos: `src/read-model/` y `src/cli/commands/{search,initiatives,log}.mjs`, `src/server/http.mjs`; tests por vista: `test/v2-search.test.mjs`, `test/v2-initiatives.test.mjs` y las rutas typed de `test/server-http.test.mjs`; `test/cli-remote-read-routing.test.mjs` solo prueba routing, no contrato de proyección. Cada vista conserva su fixture CLI+HTTP antes de retirar su ensamblado duplicado. `test/v2-status-history.test.mjs` cubre status, no el command `log`, pese a su nombre; la vista log usa sus propias pruebas de contrato.
5. **UI fuera de canonicalización** — `ui/server/server.mjs` conserva su status summary, initiative summary, stale policy (que hoy solo consulta `claim.*`, no `claimed_by`/`claimed_at` legacy) y DTO. No migrar búsquedas ni cambiar interpretación legacy de claims UI en este ADR.
6. **Retirar ensamblado duplicado** — eliminar solo la duplicación acordada después de paridad por consumer y registrar explícitamente las partes (plugin/UI/read-specific) que continúan con otro contrato.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — inspeccionados `read-model/index.mjs`, adapters status/context CLI/HTTP, `plugins/query.mjs` y `ui/server/server.mjs`, además de tests CLI/HTTP/plugin/UI. La slice 1 comparte status/context CLI/HTTP con `now` numérico; plugin puede delegar helpers puros solo si conserva su DTO e identidad; UI summary, initiative summary, scope y stale semantics se mantienen fuera. Se preserva el export `projectStatus` existente y cada adapter mantiene sus errores.
- [ ] No hace falta —

## Verificación

- Cada proyección puede probarse como función pura con snapshot literal, filtros/opciones normalizados y `now` numérico fijo, sin filesystem ni llamada interna a `Date.now()`.
- Para status/context, tests comparan CLI/HTTP con el mismo snapshot, identidad, filtros y `now`, y cubren missing state/node mapeado a los errores existentes; preservar `test/read-model.test.mjs`, `test/v2-context-contract.test.mjs`, `test/v2-status-history.test.mjs` y `test/server-http.test.mjs`.
- Plugin conserva `test/plugin-api.test.mjs` y shape `allowed_actions`; UI conserva salida/semántica en `test/ui-live.test.mjs`, incluidas las diferencias legacy de claim fields y summary. Ejecutar `npm run test:ui` al tocar consumidores/funciones usadas por UI.
- Search/initiatives/log tienen fixture CLI/HTTP antes de retirar ensamblado duplicado. Solo consumer/view marcada como delegada se cuenta bajo owner compartido; las vistas UI/plugin fuera de scope no se declaran como una única salida canónica.
- Ejecutar tests específicos por vista y `npm test`, `npm run test:ui` cuando aplique y `git diff --check`. Oxlint es informativo/no bloqueante.
