# RFC: políticas, permisos y roles extensibles por plugins

- Gate: `G-plugin-policy-rfc` · Iniciativa: `plugin-platform` · Estado: en review final
- Autor: usuario + agente principal · Fecha: 2026-08-27

## Problema

El core actual interpreta los valores `orchestrator` y `recovery` como autoridades especiales en `take`, `release`, `cancel`, `reopen` y `restore`. Eso acopla el lifecycle de Climier a un modelo operativo concreto, aunque `--as` debería solamente identificar al actor.

El host de plugins V1/V2 no tiene un punto de extensión para políticas. `api.core.run()` reutiliza los handlers core y estos aplican directamente sus reglas de ownership y autoridad. Un plugin puede envolver sus propios comandos, pero no puede imponer reglas a las invocaciones directas del CLI ni a otros plugins.

## Decisiones fijadas

- `--as` y `CLIMIER_AGENT` resuelven un `actor_id` opaco. No hay autenticación ni roles conocidos por el core.
- Una task solo puede ser resuelta por el actor que mantiene su claim activo. Un plugin no puede reemplazar esta invariante.
- Se eliminan del core las excepciones semánticas de `orchestrator` y `recovery`.
- `takeover` existe solo como acción interna del seam de policy. No es comando ni operación pública de `api.core`.
- `--allow-unregistered-initiative` se elimina del CLI público, de `api.core` y de los inputs de plugins. Se reemplaza por una capacidad interna para migraciones, imports y tests.
- Los casos de tests que hoy dependen de `orchestrator` o `recovery` se migran a un fixture de policy. No se agrega una policy de compatibilidad permanente al producto.
- Cada handler mutante invoca `authorizeAction` dentro de su `withLock` existente. La selección de policy se puede cargar antes del lock, pero la decisión se toma con el snapshot leído dentro del lock.
- Los plugins se instalan globalmente. El host descubre policies en todos los plugins instalados; cada plugin decide si aplica leyendo `projectConfig` y sus claves namespaced en `.climier.json`.
- La validación del módulo exportado pertenece a `importEntry()` en `src/plugin-descriptor.mjs`: `default.policy` es opcional, pero si existe su shape se valida antes de devolver el módulo. Un entry con commands o policy inválidos falla como unidad con `PLUGIN_LOAD_FAILED`.
- Comandos y policy viven en el mismo entry del plugin. El descriptor no agrega una segunda ruta.
- La configuración namespaced usa exactamente `projectConfig.plugins[descriptor.id]`; un plugin solo lee su propio namespace y `POLICY_CONFLICT` incluye los ids aplicables.
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
5. El host añade `loadInstalledPolicyPlugins()`, que escanea los entries instalados globalmente. `src/plugin-descriptor.mjs#importEntry` es dueño de validar el módulo exportado, después de importarlo y antes de devolverlo. Para cada entry:
   - `default.commands` debe ser un objeto;
   - `default.policy` es opcional;
   - `default.policy.applies`, si existe, debe ser función;
   - `default.policy.authorize`, si existe `policy`, debe ser función;
   - `policy` solo puede contener `applies` y `authorize`;
   - un shape inválido del entry produce `PLUGIN_LOAD_FAILED` con `details` de plugin, entry y campo inválido;
   - commands y policy se cargan como una unidad: un entry inválido no entra en degraded mode.
6. `policy.applies` es opcional: si no existe, la policy aplica a todos los proyectos. Si existe, recibe una lectura raw de `.climier.json` y devuelve boolean. El host evalúa `applies` una vez por comando, antes del lock y sin cachear el resultado entre comandos. Si `.climier.json` no existe, `projectConfig` es `{}` y una policy sin `applies` sigue aplicando; una policy con `applies` decide sobre esa configuración vacía.
7. La configuración de plugins usa un namespace estable bajo `.climier.json`, cuyo prefijo obligatorio es el `descriptor.id`:

   ```json
   {
     "version": 1,
     "project_id": "...",
     "plugins": {
       "team-policy": {
         "mode": "strict",
         "roles": {
           "alice": ["reviewer"]
         }
       }
     }
   }
   ```

   El core solo reserva el contenedor `plugins`; el payload de cada `plugins[descriptor.id]` es propiedad del plugin y no se valida ni interpreta. Una policy no puede declarar aplicabilidad basándose en el namespace de otro plugin.
8. La policy recibe solo datos serializables y read-only:

   ```js
   await policy.authorize({
     action: "task.takeover",
     actor: "alice",
     target: {
       id: "T1",
       kind: "resolvable",
       subkind: "task",
       claim: { by: "bob", at: "..." },
       previous_owner: "bob",
     },
     snapshot,
     projectConfig,
   });
   ```

   No recibe `api`, `withLock`, callbacks mutantes ni una vía para llamar `api.core.run()`.
9. `src/policy.mjs` expone conceptualmente:

   ```js
   authorizeAction({
     action,
     actor,
     target,
     snapshot,
     projectDir,
     projectConfig,
     policy,
   });
   ```

   El host lee `.climier.json` una vez antes de adquirir el lock. Si falta el archivo, usa `{}`; si `init --force` necesita crearlo, `ensureProjectMeta` ocurre antes de la selección de policy y la lectura se repite. El objeto raw se congela y se entrega a `applies` y `authorize`. El `snapshot` del DAG se construye después de `readState` dentro del lock. La llamada a `authorizeAction` se hace dentro del lock y no vuelve a leer el estado.
10. CLI y `api.core.run()` terminan en los mismos handlers. Un wrapper externo no es un mecanismo de enforcement.
11. Una policy que lanza una excepción en `applies` o `authorize` produce `POLICY_ERROR`; una policy que devuelve una forma inválida produce el mismo código. Un entry que no puede importarse o cuyo shape exportado no es válido produce `PLUGIN_LOAD_FAILED`. Una respuesta `deny` produce `POLICY_DENIED`. Dos policies aplicables producen `POLICY_CONFLICT` con sus ids y namespaces.

### Reglas de decisión

La policy se evalúa solo cuando existe una transición candidata y después de validaciones de forma y target que no son decisiones de autoridad. Las invariantes core nunca pueden ser debilitadas por un `allow`.

| Caso | Acción de policy | `allow` | `deny` | `abstain` |
|---|---|---|---|---|
| task libre | `task.take` | crea claim | `POLICY_DENIED` | crea claim por default core |
| task ya reclamada por el mismo actor | ninguna; no hay mutación | respuesta idempotente | respuesta idempotente | respuesta idempotente |
| task reclamada por otro actor | `task.takeover` | reemplaza claim | `POLICY_DENIED` | `ALREADY_CLAIMED` |
| task sin claim o con claim de otro actor al resolver | ninguna antes de la invariante | `NOT_OWNER` | `NOT_OWNER` | `NOT_OWNER` |
| task cuyo claim pertenece al actor al resolver | `task.resolve` | resuelve | `POLICY_DENIED` | resuelve por default core |
| cualquier otra mutación válida | acción del recurso | muta | `POLICY_DENIED` | default core |

Para `task.resolve`, la comprobación de owner ocurre antes de policy. Un plugin nunca puede convertir un actor no-owner en resolver.

### Takeover

`takeover` ya existe como comportamiento interno en `take.mjs`: actualmente `orchestrator` puede reemplazar un claim activo y el log conserva `previous_owner`. No existe como comando ni como operación de `api.core`.

El nuevo comportamiento conserva `climier take T1` como interfaz pública. El handler calcula bajo lock, sin inspeccionar nombres de roles:

- task disponible → `task.take`;
- task reclamada por el mismo actor → retorno idempotente;
- task reclamada por otro actor → `task.takeover`.

Solo el tercer caso consulta policy para reemplazar el claim. Si se permite, el nuevo actor pasa a ser owner y luego debe resolver la task como cualquier otro owner. Si no hay policy aplicable o la policy responde `abstain`, el claim permanece y el resultado es `ALREADY_CLAIMED`.

`task.takeover` es una acción interna del seam; no se agrega como operación pública separada a la registry de `api.core`.

### Superficie de mutaciones

El seam cubre todos los handlers mutantes de proyecto y la registry core:

```text
task.create, task.take, task.resolve, task.release, task.reopen,
task.cancel, task.update, edge.add, note.add, initiative.create,
gate.create, gate.resolve, gate.reopen, gate.cancel,
knowledge.create, knowledge.deprecate, state.restore, state.init_force
```

Para `update`, `update.mjs` lee el nodo objetivo del snapshot y clasifica el recurso dentro del propio handler, antes de invocar policy. Usa:

```text
task.update
gate.update
knowledge.update
```

Aunque exista un único `update.mjs` y la registry conserve su operación pública actual, el adapter no reescribe ni clasifica la acción. El action del seam se determina una sola vez dentro del handler a partir del `kind`/`subkind` del nodo.

`add-node` directo también pasa por el seam usando una acción de creación derivada del nodo (`task.create`, `gate.create` o `knowledge.create`). Los wrappers `add-task`, `add-gate` y `add-knowledge` delegan el chequeo al mutator real y no lo duplican.

### Capacidad interna

La opción pública `--allow-unregistered-initiative` se elimina de `knownFlags`, help y registry. El mutator interno expone una función separada, por ejemplo:

```js
addNodeInternal({
  input,
  allowUnregisteredInitiative: true,
});
```

No se implementa como environment variable, flag oculto o campo enviado por plugins. Los tests, imports de recovery y herramientas de migración llaman directamente esa capacidad interna. La capacidad no pasa por `authorizeAction`: es una operación interna de preparación y no una autorización de actor.

La migración de tests es explícita:

- `test/v2-add-task-initiative-lookup.test.mjs:95-101`: se elimina el caso CLI que prueba el flag público; se agrega una aserción de rechazo del flag público a la cobertura CLI común y la cobertura positiva pasa al test interno.
- `test/v2-initiatives.test.mjs:305-320`: se mueve el caso positivo a `test/v2-internal-capabilities.test.mjs`, que importa y prueba `addNodeInternal`.
- `test/plugin-core-registry.test.mjs:119`: se reemplaza el assert de `expose.allow_unregistered_initiative === false` por un assert de ausencia del campo en `task.create.expose`.

La aceptación de esta migración exige que ningún test ni input público contenga `allow-unregistered-initiative` como capability ejecutable y que el nuevo test interno cubra tanto iniciativa no registrada como iniciativa registrada.

### Discovery y configuración global

Los plugins se instalan en el layout global existente. El host escanea cada descriptor instalado y carga su mismo `entry`; no requiere un puntero `policy_plugin` en `.climier.json`.

El plugin puede aplicar a todos los proyectos por default o limitarse a los que tengan su configuración en `plugins[descriptor.id]`. La configuración se lee por comando y se entrega congelada a `applies` y `authorize`.

Si más de un plugin declara `applies() === true`, el host devuelve `POLICY_CONFLICT`. No se combinan políticas implícitamente en la primera versión.

### `restore` e `init --force`

`restore` sigue este orden dentro del lock:

```text
readState y validar snapshot objetivo
→ authorize("state.restore")
→ crear pre-restore snapshot
→ escribir estado restaurado
→ log
```

Así una denegación no crea un snapshot huérfano. Se acepta que policy y pre-snapshot ocupen el mismo lock. `state.restore` es el nombre canónico de la acción en policy, fixture, tests y logs; no se usa `restore` sin prefijo.

`init` normal es bootstrap y queda fuera del seam. `init --force` es una operación destructiva y usa la acción canónica `state.init_force`:

```text
resolver actor mediante --as o CLIMIER_AGENT
→ asegurar .climier.json si falta
→ leer projectConfig una vez
→ withLock
→ authorize("state.init_force")
→ crear snapshot force-init
→ escribir estado nuevo
```

Exigir actor para `init --force` es un breaking change explícito para scripts existentes y se cubre en release notes y tests. El actorless `init --force` no se conserva como fallback de policy.

### Fixture de tests

El fixture vive en:

```text
test/fixtures/plugins/policy-fixture/
  package.json
  climier.mjs
  policy.mjs
```

Descriptor:

```json
{
  "climier": {
    "id": "policy-fixture",
    "command": "policy-fixture",
    "entry": "./climier.mjs"
  }
}
```

El harness agrega un helper `installPolicyFixture()` en `test/helpers.mjs` que copia o instala el fixture bajo el `CLIMIER_HOME` temporal usado por la suite. Un helper `enablePolicyFixture(projectDir)` agrega:

```json
{
  "plugins": {
    "policy-fixture": {}
  }
}
```

al `.climier.json` del proyecto. `applies()` devuelve true solo para esos proyectos. Los tests que importan handlers directamente usan los mismos helpers y el mismo `CLIMIER_HOME` temporal; no se agrega un override del loader.

El fixture usa el `pluginId` `policy-fixture`, autoriza `orchestrator` y `recovery` por sus capacidades legacy, y también expone `fixture-admin` para tests nuevos. El actor siempre se toma de `api.runtime.agent` o de `--as` sin prefijarlo con `pluginId`.

El fixture permite las acciones que antes dependían de nombres mágicos:

```text
orchestrator:
  task.takeover
  task.release
  task.reopen
  task.cancel
  state.restore
  state.init_force

recovery:
  state.restore
  state.init_force
```

El actor recibido desde `api.core.run()` es exactamente `api.runtime.agent`; no se concatena con `pluginId`.

Inventario inicial de archivos con referencias a esos actores:

- **Usan semántica de roles y requieren fixture:** `v2-adversarial.test.mjs`, `v2-lifecycle.test.mjs`, `v2-take-by-id.test.mjs`, `v2-context-contract.test.mjs`, `snapshots-restore.test.mjs`, `cli-dispatch.test.mjs`, `plugin-api.test.mjs`, `plugin-compat.test.mjs`.
- **Usan el string como identidad de prueba y deben migrar a un actor neutro:** `v2-execution-contract.test.mjs`, `workflow-evidence-preflight.test.mjs`.
- **Ejercitan la capability interna `--allow-unregistered-initiative` y requieren migración específica:** `v2-add-task-initiative-lookup.test.mjs`, `v2-initiatives.test.mjs`, `plugin-core-registry.test.mjs`; su reemplazo está definido en la sección `Capacidad interna`.
- **Solo mencionan razones de snapshot/recovery y no autoridad de actor:** `state-snapshots.test.mjs`, `state-resilience-regression.test.mjs`.

La aceptación de la migración exige `npm test` verde y pasadas de grep que confirmen que las referencias restantes a `orchestrator`/`recovery` son solo fixture, datos históricos o nombres de escenarios, y que `allow-unregistered-initiative` solo aparece en documentación de migración y en la API interna. La pasada incluye `ui-overview.test.mjs`, cuyo registro de actividad usa `orchestrator` como dato histórico y no requiere fixture.

### Contexto read-only y help

`context.allowed_actions` deja de mencionar `orchestrator` y `recovery`. En la primera versión expone únicamente acciones garantizadas por invariantes core; no intenta proyectar grants dinámicos de policy.

La eliminación de roles mágicos incluye el help text de `bin/climier.mjs`, documentación, `context.allowed_actions` y release notes. No debe quedar documentación afirmando que `orchestrator` puede realizar bypasses core.

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
  - discovery global de policies instaladas;
  - configuración namespaced bajo `.climier.json`;
  - invocación explícita por cada handler dentro de `withLock`;
  - enforcement común para CLI y `api.core.run()`;
  - `restore` e `init --force` con acciones de policy;
  - acciones específicas por recurso para update;
  - validación de entry y errores estructurados;
  - pruebas de bypass, ownership y concurrencia.
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
- `PLUGIN_LOAD_FAILED`: entry o módulo de policy no puede cargarse o tiene shape inválido; reutiliza el error estructurado del loader de plugins.
- `POLICY_ERROR`: `applies`/`authorize` lanzó una excepción o devolvió una forma inválida.
- `POLICY_CONFLICT`: más de una policy aplicable al mismo proyecto.

Ningún fallo de policy permite completar la mutación. Una denegación no agrega un log de éxito ni un evento al state log en esta versión.

`NOT_OWNER` permanece para el rechazo core de `task.resolve` cuando el actor no posee el claim. `ALREADY_CLAIMED` permanece para un takeover donde la policy no aplica o responde `abstain`. Un `deny` explícito de la policy produce `POLICY_DENIED`. No se reemplazan entre sí.

La escritura directa al state file por un plugin está prohibida por contrato, pero no se puede impedir sin sandboxing. El plugin tampoco puede mutar durante `authorize` mediante APIs del host.

## Backlog futuro

- **Composición de policies:** soportar más de una policy aplicable, prioridades y resolución de conflictos.
- **Portabilidad de policies:** fijar versión/hash, detectar plugins ausentes y evitar divergencia entre máquinas o versiones del CLI.
- **Rendimiento y aislamiento:** medir el coste de ejecutar policies bajo lock e investigar timeout, procesos separados y límites cuando exista un consumidor real.
- **Proyección de permisos en context:** permitir que una policy exponga acciones permitidas de forma read-only sin convertir `context` en un punto de enforcement.
- **Auditoría de denegaciones:** registrar intentos rechazados sin confundirlos con mutaciones exitosas.

## ADRs derivados

- [ ] ADR-007: contrato, discovery y entry único de policy plugins → `.adrs/007-plugin-policy-contract.md`
- [ ] ADR-008: seam de autorización core, takeover y remoción de roles hardcodeados → `.adrs/008-core-policy-seam.md`
