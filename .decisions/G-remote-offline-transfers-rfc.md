# RFC: transferencia manual del DAG entre backend local y remoto

- Gate: `G-remote-offline-transfers-rfc` · Iniciativa: `remote-cloud-service` · Estado: en review
- Autor: orchestrator · Fecha: 2026-09-30

## Problema

El login y `link` del remote v2 resuelven autenticación y selección de backend, pero `link` solo escribe el origin y `project_id`; no transfiere el DAG. El ADR-043 dejó fuera `push`/`pull` y considera al server la única fuente durante el trabajo remoto. Eso no cubre el flujo ahora pedido: trabajar sobre el backend local sin Internet y enviar luego ese DAG al mismo proyecto del server, o traer el remoto al local antes de continuar offline.

La necesidad no es volver a la autenticación remota anterior ni implementar sync automático o merge. Es disponer de transferencias manuales explícitas usando el login/bearer v2, conservar el mismo `project_id`, rechazar sobrescrituras por defecto y permitir reemplazo total solo con `--force`.

## Propuesta recomendada

Reabrir el alcance del remote v2 con `push` y `pull` experimentales, de snapshot completo y sin merge:

- `push`: copia el DAG local al proyecto remoto del mismo ID. Sin `--force`, falla si el remoto avanzó desde la última sincronización local conocida. `push --force` reemplaza el DAG remoto entero por el local.
- `pull`: copia el DAG remoto al state local del mismo ID. Sin `--force`, falla si reemplazaría cambios locales todavía no sincronizados. `pull --force` reemplaza el DAG local entero por el remoto.
- `--force` es una bandera booleana después del comando (`climier push --force`, `climier pull --force`); no requiere `=true`.
- La transferencia no combina nodos, edges, logs ni dependencias. Cuando ambas copias divergen, la persona elige el lado ganador con un force. `push --force` conserva el local y descarta los cambios remotos; `pull --force` conserva el remoto y descarta los cambios locales.
- El login v2 aporta el bearer global de la instancia. Estas operaciones son excepciones explícitas que acceden a ambas copias; ningún error remoto activa fallback para los comandos normales.
- Para la primera publicación a un origin nuevo, el operador ejecuta `link`, `login` e `init` remoto; un push normal acepta el state remoto prístino que acaba de inicializarse. Un destino remoto no prístino sin base local requiere `pull` o `--force`.
- Sin `backend` en `.climier.json`, los comandos normales usan local; con remote v2, usan remoto. `link` sigue sin transferir. Quitar `backend` selecciona local; volver a ejecutar `link <origin>` selecciona remote y preserva `project_id`. El archivo es versionado, así que alternar el default solo afecta un checkout mientras no se commitee.
- Se copia el snapshot completo del state, incluidos claims, tareas `in_progress`, plugin data, nodos, edges, initiatives y log. No se filtran campos por conveniencia. Las revisiones y ledgers/fences son propios de cada instalación; el destino conserva su ledger/fence y rebasa sus revisiones al instalar. El log instalado termina con `transfer.push` o `transfer.pull`; el evento registra la revisión destino reemplazada, si existía. No se descarta en silencio ningún campo.
- La UX, CLI help y runbook marcan los comandos como experimentales y no seguros. `--force` reemplaza el DAG completo, incluido el log anterior del destino; la persona debe respaldar antes de usarlo.

## Detección simple de cambios

Cada perfil `CLIMIER_HOME` guarda un marcador local, sin secretos, en `remote-transfer-baselines/`, identificado por origin + `project_id`:

```json
{
  "version": 1,
  "origin": "https://climier.example.com",
  "project_id": "...",
  "remote_revision": 42,
  "local_revision": 19
}
```

- `remote_revision` es la revisión global recibida del server en el export o el import confirmado más reciente.
- `local_revision` es la revisión global local capturada/instalada durante esa misma transferencia.
- Un push sin force con marcador envía `expected_remote_revision`; el server lo compara con la revisión fresca bajo el mismo lock que instala el snapshot. Si no coincide, falla con `TRANSFER_REMOTE_CHANGED`, incluyendo expected/current y opciones para elegir el lado ganador. Si no hay marcador, solo se acepta el destino remoto prístino.
- Un pull sin force con marcador requiere que el state local siga en `local_revision`. Sin marcador, solo acepta un destino local ausente/prístino. Si local cambió, falla con `TRANSFER_LOCAL_CHANGED` y explica que `pull --force` reemplazará esos cambios.
- Export lee snapshot y revisión remota bajo un mismo lock. Import con CAS y reemplazo ocurren en una sola transacción de storage. Pull instala localmente bajo lock y vuelve a comprobar la revisión local esperada para no pisar una escritura concurrente.
- El marcador se escribe atómicamente con permisos privados y se actualiza solo tras una respuesta confirmada. Timeout ambiguo puede dejar el marcador viejo aunque el server haya aplicado el snapshot; no hay retry automático ni journal. El error guía a verificar/ejecutar `pull` antes de reintentar. Force siempre puede reemplazar el otro lado y se documenta como riesgoso.
- Las revisiones/fences locales y remotas no se comparan entre sí. La revisión local detecta writes locales desde la última transferencia; la revisión remota sirve como CAS. Writes directos al state file están fuera del contrato.

## Alternativas consideradas

| Opción | Resultado | Tradeoff |
|---|---|---|
| Mantener v2 remoto sin transferencias (ADR-043) | No permite publicar al server trabajo realizado en local ni continuar offline con el mismo DAG | Contradice el flujo operativo pedido; se reemplaza esa parte de la decisión. |
| Transferencias explícitas de snapshot completo, con guardas por defecto y `--force` | Permite local → remoto y remoto → local sin merge ni fallback implícito | Simple, pero una copia puede reemplazar trabajo divergente; experimental y requiere elegir el lado ganador. Recomendada. |
| Merge automático por nodos/operaciones o sincronización continua | Podría conservar cambios de ambos lados | Requiere resolver edits concurrentes, dependencias, logs y conflictos; explícitamente fuera de alcance. |

## Alcance

- Dentro:
  - Recuperar `push` y `pull` como comandos explícitos del CLI, con `--as` para auditoría y `--force` para reemplazo absoluto.
  - Transferir el snapshot completo local→remoto y remoto→local dentro del mismo `project_id`, usando el bearer del login v2.
  - Persistir el marcador local `{ origin, project_id, remote_revision, local_revision }` fuera del repo; destino ausente/prístino sin marcador; CAS remoto y detección de state local cambiado.
  - API HTTP v2 autenticada de export/import. Export devuelve snapshot + revisión desde una lectura bloqueada; import compara `expected_remote_revision` y reemplaza bajo el mismo lock. Force omite la precondición, no el lock/ledger.
  - Preservar claims, lifecycle fields y plugin data del snapshot completo; no mergearlos. Rebase de revisions/fence delegado al ledger vigente de cada destino.
  - Tests unitarios/HTTP/CLI/E2E que cubren flujo offline manual, CAS remoto, local dirty guard, force en ambas direcciones, race bajo lock, auth/protocolo, marcador no actualizado ante error/timeout y ausencia de fallback.
  - Documentar que `link` no transfiere, cómo preparar el remoto con `init`, cómo alternar backend, y los riesgos/pérdidas de `--force`.
- Fuera:
  - Merge automático, resolución de dependencias/conflictos, sincronización continua, retry/journal, HA, credenciales v1, transferencias entre `project_id` y fallback automático.
  - Hacer que `push`/`pull` creen proyectos remotos ausentes: `init` continúa siendo el único provisioner.

## Riesgos

- Ante `TRANSFER_REMOTE_CHANGED`, indicar expected/current y que `pull --force` elige remoto o `push --force` elige local. Ante `TRANSFER_LOCAL_CHANGED`, advertir que `pull --force` pierde cambios locales. Los errores deben ayudar a elegir sin prometer merge.
- Claims e `in_progress` viajan opacos; fuerza puede reactivar claims. Plugin data también se preserva, aunque los comandos/plugins remotos no están soportados.
- Force reemplaza el log de destino junto con el DAG. El evento nuevo conserva la revisión destino reemplazada, pero no el historial que se descartó.
- Timeout de push puede dejar resultado remoto desconocido sin marcador actualizado; no se promete idempotencia. No hay fallback ni retry automático.
- Marcadores son locales a cada `CLIMIER_HOME`; otro equipo debe hacer pull antes de push sobre un DAG no prístino, salvo force.
- La URL en `.climier.json` es versionada; commitear el cambio de modo afecta a otros clones.
- Los tests kernel/storage de transfer actuales son locales, no verifican wire v2; se deben extender y añadir pruebas E2E.

## Decisiones confirmadas por el usuario

- Se necesitan transferencias manuales locales/remotas; no se quiere merge ni resolución de dependencias.
- Sin force, la transferencia falla si el destino avanzó o contiene cambios locales pendientes. `--force` selecciona el lado ganador y reemplaza todo el DAG.
- El flujo es experimental y no seguro; la persona operadora asume el riesgo de pérdida con force.

## ADR derivado

- ADR propuesto: `.adrs/044-manual-offline-dag-transfers.md`, que reemplaza la exclusión de transferencias de ADR-043 §§3–4, manteniendo login v2, auth global, `link`, loopback+TLS, provisioning explícito y ausencia de fallback.
