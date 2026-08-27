# ADR-006: acciones core individuales para plugins V2

- Gate: `G-plugin-core-actions-v2-adr` · Deriva de: `G-plugin-v2-rfc` · Estado: aprobado
- Fecha: 2026-08-27

## Contexto

El RFC `G-plugin-v2-rfc` fue aprobado. V1 permite que un plugin consulte el proyecto y escriba datos aislados, pero no que cree o modifique entidades core. Esta ADR fija cómo exponer esas acciones sin ejecutar argv, duplicar el parser del CLI, introducir locks reentrantes o convertir V2 en un sistema transaccional.

La decisión conserva el alcance del RFC: una acción por llamada, sin batches, grants, capabilities, rollback ni cambios al schema de plugins. La secuenciación y el manejo de fallos parciales pertenecen al plugin.

## Decision

### API y compatibilidad

V2 agrega `core` como sibling de `runtime`, `query` y `data` en `createApi`:

```js
api.core.version === 2
api.core.run({ op, input })
```

`api.core.run` ejecuta exactamente una acción core por llamada. No recibe argv, callbacks, funciones, acceso al estado crudo ni un `as` dentro de `input`. En un host V1 `api.core` está ausente; el plugin debe detectarlo mediante `api.core?.version`.

La superficie final es:

```text
initiative.create

task.create
 task.update
 task.take
 task.release
 task.resolve
 task.reopen
 task.cancel

gate.create
 gate.resolve
 gate.reopen
 gate.cancel

knowledge.create
knowledge.deprecate

edge.add
note.add
```

`api.core.version` no es una operación de `run`. El primer hito de implementación cubre `task.create`, `edge.add`, `task.take`, `task.resolve` y `note.add`; no reduce la superficie final.

### Identidad

El host obtiene la identidad efectiva de `--as` o `CLIMIER_AGENT` y la expone como `api.runtime.agent`. Es un string de identidad para ownership y auditoría, no autenticación ni una capability. El adaptador fija `flags.as` a ese valor al invocar el handler; el plugin no puede sustituirlo desde `input`.

No se agrega una regla de privilegios en el adaptador. Los valores `orchestrator` y `recovery` conservan la semántica que ya tienen los comandos core.

El `plugin_id` proviene del descriptor instalado y no puede ser proporcionado por el plugin como parte del input.

### Registry y adaptación

La implementación mantiene una registry explícita `op → handler + mapeo JSON`. El adaptador invoca directamente los handlers core, no el parser de argv.

| Operación | Handler core | Posicional | Campos principales |
|---|---|---|---|
| `initiative.create` | `add-initiative` | `name` | `desc` |
| `task.create` | `add-task` | `id` opcional | `initiative`, `title`, `body`, `acceptance`, `blocked_by`, `tags`, `meta`, etc. |
| `task.update` | `update` | `id` | patch de campos y `if_revision` opcional |
| `task.take` | `take` | `id` | ninguno |
| `task.release` | `release` | `id` | ninguno |
| `task.resolve` | `resolve` | `id` | `note` |
| `task.reopen` | `reopen` | `id` | `reason` |
| `task.cancel` | `cancel` | `id` | `reason` |
| `gate.create` | `add-gate` | `id` opcional | `initiative`, `title`, `body`, `purpose`, etc. |
| `gate.resolve` | `resolve` | `id` | `choice`, `rationale` |
| `gate.reopen` | `reopen` | `id` | `reason` |
| `gate.cancel` | `cancel` | `id` | `reason` |
| `knowledge.create` | `add-knowledge` | `id` opcional | `initiative`, `title`, `body`, al menos un `scope_*`, etc. |
| `knowledge.deprecate` | `deprecate-knowledge` | `id` | `reason` |
| `edge.add` | `add-edge` | `from`, `to` | `type` |
| `note.add` | `add-note` | `id`, `text` | ninguno |

Los campos JSON usan snake_case y se traducen a los flags existentes (`blocked_by` → `blocked-by`, `if_revision` → `if-revision`, `scope_node_ids` → `scope-node-ids`). El adaptador valida la forma que le corresponde y el handler conserva las validaciones de dominio. `initiative.create` usa `name`; no autoasigna nombres. `task.create`, `gate.create` y `knowledge.create` conservan la asignación automática de ID cuando no reciben uno.

`allow-unregistered-initiative`, `as` y cualquier escape de recovery no se exponen como campos de `input`. La invariante de iniciativa registrada se mantiene para plugins.

Cada éxito devuelve el envelope normal del handler (`{ node }`, `{ edge }`, `{ initiative }`, o los campos derivados que ya entregue el comando). No se agrega un envelope de secuencia ni se uniforman artificialmente esos resultados.

### Locks y logs

`api.core.run` no toma un lock propio. El handler invocado conserva su `withLock → updateState → append`, por lo que una llamada de plugin y una llamada CLI compiten bajo el mismo lock de proyecto.

Para atribuir las acciones sin escribir un log paralelo, `src/log.mjs` agrega `appendWithContext(projectDir, entry, { pluginId })`. Los handlers adaptados reciben `pluginId` como contexto interno y usan ese helper. El helper agrega `plugin_id` al entry; el valor nunca viene de `input`. La llamada CLI normal continúa usando `append()` sin `plugin_id`.

El cambio de estado y el log permanecen dentro del mismo `withLock` existente. V2 no introduce `commitWithLog`; una transacción entre varias llamadas queda diferida a `T-plugin-v3-transactions-backlog`.

### Errores

`src/plugin-errors.mjs` define los errores específicos y un wrapper central `wrapCoreError(op, err)`:

- `PLUGIN_CORE_INVALID_OPERATION`: la operación no existe o el adaptador no puede mapear la forma de `input`. Ocurre antes del lock y usa:

```json
{
  "plugin_id": "example.audit",
  "op": "edge.unknown",
  "supported": ["edge.add"],
  "reason": "unknown operation"
}
```

- `PLUGIN_CORE_ACTION_FAILED`: el handler core rechazó la acción. Usa:

```json
{
  "plugin_id": "example.audit",
  "op": "edge.add",
  "cause": {
    "code": "CYCLE_DETECTED",
    "message": "...",
    "details": {}
  }
}
```

`details.op` siempre es el string de la operación. `cause` siempre es JSON serializable; si el error core no tiene código, se conserva como `CORE_ERROR` con su mensaje. Los errores `PLUGIN_CORE_*` no se vuelven a envolver como `PLUGIN_HANDLER_FAILED`.

### Secuencias parciales

El host no conoce ni persiste secuencias. Un plugin que encadena llamadas puede usar `try/catch`, conservar los resultados exitosos y devolver su propio resultado al caller. Una acción exitosa permanece aunque falle la siguiente. `task.cancel` sigue siendo una acción ordinaria y no un rollback garantizado.

No se agregan campos de origen a los nodes ni cambios a `status` o `context` en V2. `history <id>` identifica `plugin_id`, agente y acción sin registrar cuerpos, metadata completa ni datos privados.

## Consecuencias

- A favor: los plugins reutilizan las validaciones, lifecycle, ownership, DAG, locks y logs existentes del core.
- A favor: la superficie final es general, pero la implementación puede avanzar por slices verificables.
- A favor: no hay parser de argv, lock reentrante, grants, cambio de schema ni transacción nueva.
- A favor: los errores identifican la operación y conservan la causa estructurada del core.
- En contra / deuda: una secuencia puede dejar estado parcial y el plugin debe manejarlo con `try/catch`.
- En contra / deuda: la atribución de plugin se consulta en `history`; `status` y `context` no muestran un origen adicional.
- En contra / deuda: la propagación explícita de `pluginId` requiere adaptar los handlers que participan en cada slice.
- Follow-up: batches, rollback y transacciones se investigan solo si un consumidor real promueve `T-plugin-v3-transactions-backlog`.

## Plan de implementación

1. **API core y errores** — `src/plugin-api.mjs`, nuevo módulo de core/registry y `src/plugin-errors.mjs`; exponer `api.core.version`, validar operaciones y centralizar `PLUGIN_CORE_*`.
2. **Seam de logs y first slice** — `src/log.mjs`, `src/commands/add-task.mjs`, `src/commands/add-edge.mjs`, `src/commands/take.mjs`, `src/commands/resolve.mjs`, `src/commands/add-note.mjs`; propagar `pluginId` explícitamente y cubrir el flujo spec-to-DAG mínimo.
3. **Adaptadores restantes** — commands de initiatives, update/release/reopen/cancel de tasks, gates y knowledge; mantener la misma registry, mapeos y envelopes.
4. **Paridad y compatibilidad** — tests unitarios de cada mapeo y error, ausencia de `api.core` en V1 y preservación de la superficie V1.
5. **Fixture e integración** — fixture instalada que invoque varias acciones, captura un fallo parcial y verifica `history`; prueba `child_process` con CLI/data concurrentes y `CLIMIER_HOME` compartido.

## Checkpoint de planificación post-ADR

Por la cantidad de módulos, el seam compartido de logs, la registry y la prueba entre procesos, el checkpoint será **Bootstrap**. No se crean tasks de implementación directamente después de aprobar esta ADR.

- [ ] Sin bootstrap — no aplica: el ADR requiere un mapa de ownership y dependencias antes de repartir las piezas.
- [x] Bootstrap — crear `T-plugin-core-actions-v2-bootstrap`, bloqueada por `G-plugin-core-actions-v2-adr`, cuyo único entregable sea `docs/plans/plugin-core-actions-v2-execution.md` con paths exclusivos, batches, dependencias, estrategia de pruebas, riesgos y propuestas de tasks.

## Verificación

- `node --test test/plugin-api.test.mjs`
- `node --test test/plugin-dispatch.test.mjs`
- `node --test test/plugin-integration.test.mjs`
- `npm test`
- Smoke instalado: un fixture V2 detecta `api.core.version`, crea una task, agrega un edge, toma y resuelve la task, añade una nota y verifica sus envelopes/logs.
- Error smoke: una operación desconocida, input no mapeable, ownership inválido, revisión obsoleta y ciclo devuelven `PLUGIN_CORE_*` sin mutar.
- Concurrencia: dos `child_process` comparten `CLIMIER_HOME`; uno ejecuta un plugin V2 y otro una mutación CLI/data, y las aserciones verifican estado final íntegro, serialización y logs esperados.
