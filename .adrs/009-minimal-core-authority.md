# ADR-009: autoridad mínima del core y takeover opcional por plugin

- Iniciativa: `plugin-platform`
- Reemplaza: ADR-008, en la parte de autoridad de lifecycle
- Estado: propuesto

## Contexto

La implementación del seam de policies eliminó los hatches hardcodeados por nombre (`orchestrator` y `recovery`), pero conservó reglas de ownership para `resolve`, `release`, `cancel` y `reopen`. El comportamiento buscado es más pequeño: Climier no debe imponer una política de autorización general ni interpretar roles. El core solo debe proteger la exclusión mutua de los claims durante `take`; el resto de las operaciones debe depender de sus precondiciones de estado.

La infraestructura de extensión de policies puede permanecer para que un plugin agregue restricciones o autorice un takeover. Eso no convierte a Climier en una policy por defecto: sin plugin aplicable no hay autorización adicional.

## Decisión

### Identidad

`--as` y `CLIMIER_AGENT` son identificadores opacos usados para el claim y la auditoría. No autentican, no son roles y no conceden privilegios. Los comandos mutantes conservan los requisitos de actor que necesiten para registrar quién ejecutó la operación, pero esos requisitos no son checks de ownership.

### Única invariancia de autoridad del core: `take`

Para una task resolvable:

| Estado bajo el lock | Resultado sin policy | Extensión opcional |
|---|---|---|
| Sin claim | `task.take` crea el claim del actor | una policy puede denegar el take |
| Claim del mismo actor | operación idempotente, sin nueva mutación | igual |
| Claim de otro actor | `ALREADY_CLAIMED`, sin mutación | `task.takeover` puede ser autorizado por una policy; reemplaza el claim y guarda `previous_owner` |

La clasificación y la decisión ocurren bajo el lock existente. Ninguna policy puede romper la exclusión mutua ni producir dos claims ganadores. `task.takeover` sigue siendo una acción interna del seam, no un comando público.

### Resto de operaciones

Por defecto, sin policy aplicable o con `abstain`, el actor no necesita ser owner ni `done_by` para ejecutar una operación. Se conservan solamente las validaciones de forma, existencia y estado que hacen válida la transición:

- `resolve` no exige claim ni compara `claim.by`; una task/gate en un estado resoluble puede ser resuelta por cualquier actor.
- `release` puede liberar un claim existente sin comparar el actor; sin claim conserva su no-op idempotente.
- `cancel` puede cancelar cualquier nodo resolvable en un estado cancelable, tenga o no claim.
- `reopen` puede reabrir cualquier task/gate en estado terminal reabrible, sin comparar `done_by`.
- updates, notas, creación, deprecación, edges, restore e init force mantienen sus validaciones de datos/estado y no agregan ownership.

Si existe una policy aplicable, puede denegar acciones o autorizar explícitamente acciones de su contrato. La ausencia de policy no introduce un permiso implícito por nombre de actor. El `allow` de una policy no puede debilitar la exclusión mutua de `take`; para una task ya tomada el camino explícito es `task.takeover`.

### Contexto y documentación

`context.allowed_actions` debe describir acciones posibles por invariantes de estado, no grants de ownership ni nombres de roles. La documentación debe distinguir entre:

1. la invariancia core de no sobrescribir claims;
2. la policy opcional instalada por un plugin;
3. la identidad opaca usada para auditoría.

No se agrega autenticación, composición de policies, sandboxing, timeout dedicado ni auditoría persistente.

## Compatibilidad y alcance

Este cambio modifica el contrato público de ownership de lifecycle: clientes que dependían de `NOT_OWNER` para `resolve`, `release`, `cancel` o `reopen` deben actualizarse. El estado v2 y la atomicidad no cambian.

La implementación debe tocar solo los handlers, contexto, documentación y tests necesarios para este contrato. No se deben reintroducir strings con autoridad especial ni editar el estado fuera de los comandos Climier.

## Verificación

- Tests focalizados de lifecycle, context y policy.
- Casos sin policy y con policy allow/deny/abstain para takeover y para una operación no protegida.
- CLI y `api.core.run()` con el mismo actor y acción.
- Concurrencia de dos `take` sobre una task.
- `npm test`, `npm run test:concurrent` y `git diff --check`.
