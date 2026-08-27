# RFC: políticas, permisos y roles extensibles por plugins

- Gate: `G-plugin-policy-rfc` · Iniciativa: `plugin-platform` · Estado: en review
- Autor: usuario + agente principal · Fecha: 2026-08-27

## Problema

El core actual interpreta los valores `orchestrator` y `recovery` como autoridades especiales en `take`, `release`, `cancel`, `reopen` y `restore`. Eso acopla el lifecycle de Climier a un modelo operativo concreto, aunque `--as` debería solamente identificar al actor.

El host de plugins V1/V2 no tiene un punto de extensión para políticas. `api.core.run()` reutiliza los handlers core y estos aplican directamente sus reglas de ownership y autoridad. Un plugin puede envolver sus propios comandos, pero no puede imponer reglas a las invocaciones directas del CLI ni a otros plugins.

## Decisiones fijadas

- `--as` y `CLIMIER_AGENT` resuelven un `actor_id` opaco. No hay autenticación ni roles conocidos por el core.
- La resolución de una task sigue requiriendo que el actor tenga el claim activo. El plugin no puede reemplazar esa invariante.
- Se eliminan del core las excepciones semánticas de `orchestrator` y `recovery`.
- El takeover existe como acción interna de autorización, no como comando ni como operación pública separada.
- `--allow-unregistered-initiative` se elimina del CLI público, de `api.core` y de los inputs de plugins. Se reemplaza por una capacidad interna para migraciones, imports y tests.
- Los tests que hoy dependen de `orchestrator` o `recovery` se migran a un fixture de policy. No se agrega una policy de compatibilidad permanente al producto.
- Cada handler mutante invoca `authorizeAction` dentro de su `withLock` existente.
- Los plugins se instalan globalmente. El host descubre policies en todos los plugins instalados; cada plugin determina si aplica al proyecto leyendo la configuración namespaced que le corresponda en `.climier.json`.
- Comandos y policy viven en el mismo entry del plugin. El descriptor no agrega una segunda ruta.
- La primera versión soporta una única policy aplicable por proyecto. Si más de una declara aplicabilidad, se informa `POLICY_CONFLICT`; la composición queda en backlog.
- `restore` y `init --force` quedan gobernados por policy. `init` normal permanece como bootstrap fuera del seam.
- Las denegaciones no escriben eventos en el log de estado en esta versión.
- No se agrega timeout de policy en esta versión; rendimiento, timeouts y aislamiento quedan en backlog.

## Propuesta

Separar identidad, invariantes de lifecycle y política:

1. `--as` y `CLIMIER_AGENT` continúan resolviendo un actor opaco.
2. El core conserva invariantes técnicas y de coordinación:
   - DAG, estados válidos, locks, escrituras atómicas y logs;
   - `take` conserva el claim exclusivo y atómico por defecto;
   - una task solo puede ser resuelta por el actor que tiene su claim activo;
   - el actor que resuelve queda registrado en `done_by` y en el log.
3. El core deja de comparar identidades contra strings de roles. Si un proyecto quiere roles como `orchestrator`, `recovery`, `reviewer` o `admin`, esos roles los define un plugin.
4. Se agrega una capacidad opcional de policy al entry del plugin:

   ```js
   import policy from "./policy.mjs";

   export default {
     commands: {
       roles: async (argv, api) => {
         // comando normal del plugin
       },
     },
     policy: {
       applies: policy.applies,
       authorize: policy.authorize,
     },
   };
   ```

   Un plugin sin `policy` sigue siendo un plugin normal.
5. El host descubre policies globalmente escaneando los entries instalados. Para cada entry:
   - `default.commands` debe existir;
   - `default.policy` es opcional;
   - `default.policy.applies`, si existe, debe ser función;
   - `default.policy.authorize` debe ser función;
   - un `policy` mal formado produce un error de carga estructurado.
6. `applies` recibe el proyecto y una lectura raw de `.climier.json`. El plugin puede leer sus propias claves namespaced o decidir aplicar a todos los proyectos. Climier no interpreta esas claves.
7. `authorize` recibe solo datos serializables y read-only:

   ```js
   await policy.authorize({
     action: "task.takeover",
     actor: "alice",
     target: {
       id: "T1",
       kind: "resolvable",
       subkind: "task",
       claim: { by: "bob", at: "..." },
     },
     snapshot,
     project_config,
   });
   ```

   No recibe `api`, `withLock`, callbacks mutantes ni una vía para llamar `api.core.run()`.
8. La respuesta de policy es:

   ```js
   { decision: "allow" }
   { decision: "deny", reason: "..." }
   { decision: "abstain" }
   ```

   `deny` produce `POLICY_DENIED`; `abstain` deja que continúen las invariantes y defaults core.
9. Cada handler mutante invoca `authorizeAction` dentro de su lock:

   ```text
   withLock
     → readState
     → clasificar la acción contra el estado actual
     → authorizeAction
     → validar/aplicar transición core
     → updateState
     → append
   ```

   El helper se define en `src/policy.mjs` con esta firma conceptual:

   ```js
   authorizeAction({
     action,
     actor,
     target,
     snapshot,
     projectDir,
     projectConfig,
   });
   ```

   La selección/import de la policy puede resolverse antes del lock, pero la llamada de decisión se hace con el snapshot leído dentro del lock.
10. CLI y `api.core.run()` terminan en los mismos handlers. Un wrapper externo no es un mecanismo de enforcement.
11. Si no hay policy aplicable o la policy responde `abstain`, se aplican los defaults core. En particular:
    - una task reclamada por otro actor no admite `takeover` sin autorización;
    - `task.resolve` sigue exigiendo que el actor sea el owner del claim;
    - no existen bypasses core para `orchestrator` o `recovery`.

### Takeover

`takeover` ya existe como comportamiento interno en `take.mjs`: actualmente `orchestrator` puede reemplazar un claim activo y el log conserva `previous_owner`. No existe como comando ni como operación de `api.core`.

El nuevo comportamiento conserva `climier take T1` como interfaz pública. El handler calcula bajo lock:

- `task.take`: task disponible o ya reclamada por el actor;
- `task.takeover`: task reclamada por otro actor.

Solo el segundo caso consulta una policy para permitir reemplazar el claim. Si se permite, el nuevo actor pasa a ser owner y luego debe resolver la task como cualquier otro owner. Si no se permite, el core devuelve `ALREADY_CLAIMED` o la policy devuelve `POLICY_DENIED`, según el contrato final de la acción.

`task.takeover` es una acción interna del policy seam; no se agrega como operación pública separada a la registry de `api.core`.

### Superficie de mutaciones

El seam cubre todos los handlers mutantes de proyecto y la registry core:

```text
task.create, task.take, task.resolve, task.release, task.reopen,
task.cancel, task.update, edge.add, note.add, initiative.create,
gate.create, gate.resolve, gate.reopen, gate.cancel,
knowledge.create, knowledge.deprecate, restore
```

El helper construye acciones específicas por recurso para actualizaciones:

```text
task.update
 gate.update
 knowledge.update
```

Aunque `update.mjs` sea un único handler, el nodo objetivo determina la acción que recibe la policy.

`add-node` directo también debe pasar por el seam usando una acción de creación derivada del nodo (`task.create`, `gate.create` o `knowledge.create`).

`--allow-unregistered-initiative` queda fuera de esta superficie pública.

### Capacidad interna

La opción pública `--allow-unregistered-initiative` se elimina de `knownFlags`, help y registry. El mutator interno expone una función separada, por ejemplo:

```js
addNodeInternal({
  ...input,
  allowUnregisteredInitiative: true,
});
```

No se implementa como environment variable, flag oculto o campo enviado por plugins. Los tests, imports de recovery y herramientas de migración llaman directamente esa capacidad interna.

### `restore` e `init --force`

`restore` mueve su gate de autoridad dentro del `withLock` y consulta `state.restore` antes de escribir.

`init` normal es bootstrap y queda fuera del seam. `init --force` es una operación destructiva y consulta `state.init_force`; cuando usa una policy debe resolver actor mediante `--as` o `CLIMIER_AGENT`.

### Fixture de tests

El fixture de policy se ubica en:

```text
test/fixtures/plugins/policy-fixture/
  package.json
  climier.mjs
  policy.mjs
```

Descriptor del fixture:

```json
{
  "climier": {
    "id": "policy-fixture",
    "command": "policy-fixture",
    "entry": "./climier.mjs"
  }
}
```

El fixture define las autorizaciones que antes dependían de nombres mágicos, incluyendo takeover, release/reopen/cancel ajenos y restore.

Inventario de archivos con referencias a esos actores, para migrar según el caso:

- **Usan la semántica de roles y requieren fixture:** `v2-adversarial.test.mjs`, `v2-lifecycle.test.mjs`, `v2-take-by-id.test.mjs`, `v2-context-contract.test.mjs`, `snapshots-restore.test.mjs`, `cli-dispatch.test.mjs`, `plugin-api.test.mjs`, `plugin-compat.test.mjs`, `state-resilience-regression.test.mjs`.
- **Solo usan el string como identidad de prueba o nombre de escenario:** `v2-execution-contract.test.mjs`, `v2-add-task-initiative-lookup.test.mjs`, `workflow-evidence-preflight.test.mjs`.
- **Solo mencionan razones de snapshot/recovery, sin autoridad de actor:** `state-snapshots.test.mjs`.

Los tests core de identidad reemplazan `orchestrator` por actores neutros. Los tests de takeover y recuperación instalan el fixture y prueban el contrato de policy, no privilegios incorporados.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener `orchestrator`/`recovery` en el core | Cambio pequeño; conserva el comportamiento actual | Acopla Climier a un workflow específico |
| Envolver comandos core desde un plugin | Implementación rápida | Se puede evadir ejecutando el CLI o `api.core.run()` directamente |
| **Policy opcional en el entry global del plugin — recomendada** | Roles y reglas viven fuera del core; CLI y API comparten enforcement | Agrega código externo al camino crítico de mutaciones |
| Sistema de autenticación dentro de Climier | Permitiría seguridad real | Fuera del propósito de Climier; `--as` no es autenticación |

## Alcance

- Dentro:
  - identidad sin roles implícitos;
  - ownership del claim para resolver tasks;
  - eliminación de excepciones core de `orchestrator`/`recovery`;
  - acción interna `task.takeover`;
  - `--allow-unregistered-initiative` como capacidad interna;
  - fixture de policy y migración de tests;
  - policy opcional en el mismo entry que `commands`;
  - descubrimiento global de policies instaladas;
  - configuración namespaced leída por el propio plugin desde `.climier.json`;
  - invocación explícita por cada handler dentro de `withLock`;
  - enforcement común para CLI y `api.core.run()`;
  - `restore` e `init --force` con acciones de policy;
  - acciones específicas por recurso para update;
  - errores estructurados y pruebas de bypass/concurrencia.
- Fuera:
  - autenticación, firma de identidades o seguridad del sistema operativo;
  - sandboxing general de plugins;
  - composición de múltiples policies;
  - compatibilidad entre máquinas o versiones de plugins;
  - optimización de latencia, timeout o aislamiento de procesos;
  - auditoría persistente de denegaciones;
  - escape administrativo especial dentro del core.

## Errores y contrato de fallos

- `POLICY_DENIED`: policy aplicable respondió `deny`.
- `POLICY_LOAD_FAILED`: entry o módulo de policy no puede cargarse.
- `POLICY_ERROR`: `authorize` lanzó una excepción o devolvió una forma inválida.
- `POLICY_CONFLICT`: más de una policy aplicable al mismo proyecto.

Ningún fallo de policy permite completar la mutación. Una denegación no agrega un log de éxito ni un evento al state log en esta versión.

`NOT_OWNER` permanece para el rechazo core de `task.resolve` cuando el actor no posee el claim. No se reemplaza por `POLICY_DENIED`.

## Riesgos y open questions

- Un plugin de policy pasa a estar en el camino crítico de las mutaciones. En esta fase se acepta que un plugin habilitado que falla pueda hacer fallar la operación; no se hace fallback silencioso.
- La policy se ejecuta dentro del lock y recibe un snapshot read-only. No puede usar APIs mutantes ni llamar `api.core.run()` durante `authorize`.
- `--as` sigue siendo falsificable: esto sirve para coordinación y workflow, no para autenticación. Debe quedar documentado en la referencia de plugins.
- Un plugin puede escribir directamente al filesystem si decide ignorar el contrato. El host no lo puede impedir sin sandboxing; la regla será contractual.
- `context.allowed_actions` debe dejar de mencionar `orchestrator`/`recovery`. La primera implementación mostrará solo acciones garantizadas por invariantes core; los permisos específicos del plugin no se proyectan todavía.
- La aplicabilidad se resuelve con `policy.applies` y configuración namespaced del plugin. El host no agrega un opt-in de policy al schema core.
- La primera implementación falla con `POLICY_CONFLICT` si más de un plugin es aplicable; la composición avanzada queda en backlog.
- La política de `init --force` debe ejecutarse antes del wipe y después de resolver el actor; el bootstrap normal queda fuera.
- El fixture de compatibilidad es solo de tests. La remoción de roles mágicos es un breaking change documentado en release notes.

## Backlog futuro

- **Composición de policies:** soportar más de una policy aplicable, prioridades y resolución de conflictos.
- **Portabilidad de policies:** fijar versión/hash, detectar plugins ausentes y evitar divergencia entre máquinas o versiones del CLI.
- **Rendimiento y aislamiento:** medir el coste de ejecutar policies bajo lock e investigar timeout, procesos separados y límites cuando exista un consumidor real.
- **Proyección de permisos en context:** permitir que una policy exponga acciones permitidas de forma read-only sin convertir `context` en un punto de enforcement.
- **Auditoría de denegaciones:** registrar intentos rechazados sin confundirlos con mutaciones exitosas.

## ADRs derivados

- [ ] ADR-NNN: contrato, discovery y entry único de policy plugins → `.adrs/NNN-plugin-policy-contract.md`
- [ ] ADR-NNN: seam de autorización core, takeover y remoción de roles hardcodeados → `.adrs/NNN-core-policy-seam.md`
