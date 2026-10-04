# Decisión de alcance: remote v1 mínimo

- Gate: `G-rb-minimal-v1` · Iniciativa: `remote-backend` · Estado: aprobado
- Deriva de: `G-remote-backend-rfc`
- Fecha: 2026-09-25

## Problema

La iniciativa remota ya tiene una base real de cliente, HTTP server, auth por proyecto, catálogo confinado, lecturas remotas y ledger fenced. Pero su contrato acumuló transferencias con journal/retry/CAS, provisioning con capacidades adicionales y un E2E de host antes de cerrar el recorrido básico de escritura. Hoy algunas mutaciones permitidas bajo `backend=remote` todavía alcanzan el DAG local.

Necesitamos una decisión de release que preserve la seguridad esencial —servidor autoritativo, no fallback local, locks y commits canónicos— y posponga la complejidad que no es necesaria para usar Climier remoto normalmente.

## Propuesta

Aprobar [ADR-027](../.adrs/027-minimal-remote-v1.md) como enmienda de release para `remote-backend` v1:

1. Bearer token desde `CLIMIER_TOKEN`, con scope por `project_id`; `.climier.json` no contiene secretos y `--as` permanece auditoría.
2. Launcher server-side con catálogo confiable y storage interno aislado por proyecto.
3. Lecturas, todas las mutaciones built-in y `core.batch` se enrutan por una única frontera cliente local/remota; remoto nunca toca el DAG local.
4. `init` remoto crea solo un state ausente para un proyecto ya catalogado y scoped; `init --force` remoto no está soportado.
5. `push`/`pull` básicos copian DAG+log de manera explícita, create-only/prístino por defecto o `--overwrite=true` absoluto. Rechazan claims, tareas in-progress y plugin data; conservan el ledger/generación del destino; no tienen journal, UUID, status ni retry automático.
6. `restore`, snapshots, UI y APIs/comandos de plugins remotos quedan no soportados. Recovery fenced local de restore/init force sí se completa.
7. E2E local y runbook son acceptance de release; Tailscale es solo smoke temporal redactado después de las pruebas automatizadas.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| **V1 mínimo de ADR-027** | Cierra el flujo útil de Climier remoto, elimina writes locales accidentales y mantiene una superficie operable | Overwrite absoluto y timeout de push requieren cuidado manual; plugins y recovery remoto quedan fuera |
| Mantener RFC/ADR-025 completo antes de release | Más garantías de transferencia desde el primer día | Journal, retry, transfer status y CAS desplazan la entrega del flujo básico y duplican trabajo de recovery |
| Volver a backend solo de lecturas | Menor trabajo inmediato | No satisface coordinación real entre agentes remotos ni aprovecha la API de operaciones ya existente |
| Revertir ledger/fence v5 | Menos conceptos de storage | Reabre trabajo aceptado y pierde la protección que ya necesita el estado compartido |

## Alcance

Dentro: contrato y launcher del server, init remoto scoped, bridge de operaciones, todas las mutaciones built-in/batch, recovery fenced local, push/pull básicos, documentación y E2E local + smoke Tailscale.

Fuera: sync/merge/cache, journal/transfer-status/retry, CAS de overwrite, plugin-data transfer, restore/snapshots/UI remotos, extensiones plugin remotas, HA/SaaS/roles completos y secretos versionados.

## Riesgos y mitigaciones

- **Escritura local accidental:** routing remoto central antes de policy/plugins/storage locales; tests con sentinel local para éxito y fallos.
- **Overwrite destructivo:** requiere `--overwrite=true`, se documenta y se crea backlog de CAS explícito.
- **Claims duplicados:** la fuente con claim o `in_progress` se rechaza; el destino se publica bajo lock.
- **Timeout ambiguo de push:** se retorna `TRANSFER_OUTCOME_UNKNOWN`; no retry automático.
- **Plugin data:** se rechaza el transfer en vez de descartar datos.
- **Storage server-side mal ligado:** launcher prueba que el `project_id` externo nunca decide una ruta de state/ledger/lock.

## Decisiones derivadas

- [x] ADR-027: remote v1 mínimo, operaciones tipadas y transferencias explícitas — `.adrs/027-minimal-remote-v1.md`
- [x] Curar el DAG de tasks existente conforme a ADR-027 antes de delegar workers.
