# ADR-025: transferencias completas explícitas push/pull

- Gate: `G-remote-dag-transfers` · Deriva de: `G-remote-backend-rfc` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

`push` y `pull` permiten bootstrap/backup explícitos, no sincronización continua. Reemplazar un DAG entero puede perder historial/claims o reactivar CAS, y un timeout puede dejar resultado desconocido. El RFC define fuente/destino, CAS, restricciones de claims, auditoría, revisión fence y journal idempotente.

## Decisión

- Implementar comandos JSON `push` local→remote y `pull` remote→local contra el endpoint/project_id explícito de `.climier.json`; no alteran backend seleccionado ni mantienen sync.
- Fuente exacta se captura bajo lock y se hash/revisiona. Destino ausente/prístino sigue reglas create-only; cualquier otro destino divergente requiere `--overwrite=true` y revisión esperada CAS, comparada y commit bajo lock destino.
- Rechazar fuente y reemplazo de destino con claims activos o tasks `in_progress`; validar schema antes de cualquier commit. Conflicto/fallo no cambia destino.
- El kernel ejecuta replace dedicado: preserva log destino, agrega un evento auditable con payload fuente namespaced, rebasa state/nodos por encima de high-water destino y conserva `fence_generation` destino; no copia ledger ni credenciales.
- Journal local durable genera UUID antes del request y conserva payload snapshot para retry exacto. `transfer-status` resuelve incertidumbre; mismo fingerprint idempotente, diferente fingerprint da `TRANSFER_ID_CONFLICT`. Push guarda fingerprint server-side junto al commit; pull marker junto al state/log local.
- Success envelope incluye direction, project_id, source/destination, source_hash/revision, destination_revision_before/after, applied_revision y overwritten. Timeout sin confirmación usa `TRANSFER_OUTCOME_UNKNOWN`/`applied:"unknown"`.

## Consecuencias

- A favor: transferencias recuperables, explícitas, auditables y protegidas contra overwrite/CAS obsoletos.
- En contra / deuda: journal/payload requiere retención y limpieza; transacción cruza state, ledger y marker/journal, por lo que necesita diseño y pruebas crash-specific.
- No se implementa sync incremental, merge ni operación offline.

## Plan de implementación

1. Kernel operation de replace con CAS, claims, audit y fence destino; archivos: `src/kernel/transfer*`, storage y tests concurrentes (depende de ADR-023).
2. Cliente journal durable e idempotency/status; archivos: storage transfers y tests de crash/timeout.
3. Adapters `push`/`pull`/`transfers`/`transfer-status` y envelopes; archivos: `src/cli/commands/`, dispatch/help y tests.
4. Round-trip y race tests remotos/locales contra service API; archivos: tests integration.

## Onboarding breve para crear tasks

- [x] No hace falta: RFC fija contrato observable de fuentes, destinos, CAS, outcomes y transfer ID.

## Verificación

- Round-trip preserva DAG y log destino; ledger/generación del destino permanece local.
- Conflicto CAS/claims no cambia destino; carrera sincronizada permite un ganador y solo un evento de auditoría.
- Retry tras timeout con mismo UUID/payload no duplica auditoría; fingerprint distinto se rechaza.
- Snapshots y credenciales no se incluyen en estado transferido; ningún comando hace sincronización automática.
