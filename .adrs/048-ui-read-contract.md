# ADR-048: contrato de lectura de UI y proyección server-side

- Gate: `G-ui-adr-read-contract` · Deriva de: `G-ui-hosted-rfc` · Estado: aprobado
- Fecha: 2026-10-05

## Contexto

El cliente `climier-ui` hoy lee un snapshot estático
(`ui/src/modules/tasks/data/climier/contract.ts`, `realSnapshot.json`). La UI
experimental anterior construía su propio snapshot en `ui/server/server.mjs`
con helpers duplicados. Para servirlo en vivo hace falta una proyección única
que no derive del CLI ni copie semántica. Ver `.decisions/G-ui-hosted-rfc.md`.

## Decisión

1. **Dueño único de la proyección**: módulo puro en `src/read-model/ui.mjs`
   (o `src/read-model/ui/`), apoyado en `derive`, `statusOf`,
   `blockingForNode`, `knowledgeForNode`, `informingForNode`, `isCurrent`,
   `supersededBy`. Sin I/O, testeable con snapshots literales.
   - `projectUiSnapshot({ snapshot, now, activityLimit })` → forma exacta de
     `ClimierSnapshot`.
   - `projectUiNode({ snapshot, id, now })` → contrato de detalle de nodo
     (blocking, dependents, informing, knowledge, history, refs,
     derived_status, supersession).
   - `projectUiActivity({ snapshot, filters, limit, offset })` →
     `{ entries, total, limit, offset, facets }`.
2. **Endpoints** dedicados bajo `/v1/projects/:id/ui/*`, autenticados con bearer
   y header de protocolo, orquestados en un único adaptador HTTP
   (`src/server/http/ui-api.mjs`) montado desde `src/server/http.mjs`. El
   adapter solo hace I/O y validación de query; toda la semántica vive en
   `read-model/`.
3. **Forma del snapshot**: la de `contract.ts`. `project` expone solo
   `{ id, name, revision, generated_at }`; no se exponen `root` ni
   `state_file`. `recent_activity` se limita a 50 entradas y la lista completa
   se pagina por `/ui/activity`.
4. **Errores**: envelope existente
   `{ ok:false, error:{ code, message, details } }`. Un proyecto sin estado
   responde `STATE_NOT_INITIALIZED`; un proyecto inexistente
   `UNKNOWN_PROJECT`; query inválida, error de validación como hoy.
5. **Alineación con el cliente**: se corrige `contract.ts` para no requerir
   `root`/`state_file`; el snapshot de desarrollo puede seguir usándolos como
   opcionales. Los tests de contrato fijan la forma server↔cliente.

## Consecuencias

- A favor: una sola semántica de lectura; elimina la lógica duplicada de
  `ui/server/server.mjs`; el cliente no recomputa derivaciones pesadas.
- A favor: el contrato queda testeado con snapshots literales, sin filesystem.
- En contra / deuda: `read-model/` gana una vista orientada a UI; hay que
  evitar que crezca con campos específicos de presentación (no colores, no
  layout).
- En contra / deuda: el límite de `recent_activity` obliga a que cualquier
  vista histórica use `/ui/activity`; se documenta en el cliente.

## Plan de implementación

1. **Proyección pura** — `src/read-model/ui.mjs`,
   `test/read-model-ui.test.mjs` (literales: summary, initiative_summary,
  alerts, recent_activity cap, detalle, facets).
2. **API HTTP** — `src/server/http/ui-api.mjs`, montaje en
   `src/server/http.mjs`, `test/server/http/ui-api.test.mjs` (auth, query,
  errores, estado ausente).
3. **Ajuste de contrato del cliente** — `contract.ts`, `projection.ts` y sus
  consumidores directos para tolerar la ausencia de `root`/`state_file`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — la proyección y el adaptador HTTP son tasks
  distintas; el ajuste de contrato del cliente comparte path con la task de
  migración reactiva, se coordina por dependencia (la proyección primero).

## Verificación

- `node --test test/read-model-ui.test.mjs` con snapshots literales.
- `node --test test/server/http/ui-api.test.mjs` con un proyecto temporal
  (estado inicializado, sin estado, proyecto desconocido, query inválida).
- El snapshot de la proyección satisface el tipo `ClimierSnapshot` del cliente
  (fixture de contrato).
