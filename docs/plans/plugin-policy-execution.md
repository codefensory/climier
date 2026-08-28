# Plan de ejecución: policies extensibles, seam core y migración de roles

Plan derivado de `.adrs/007-plugin-policy-contract.md` (ADR-007, aprobado)
y `.adrs/008-core-policy-seam.md` (ADR-008, aprobado). Convierte el
contrato de los dos ADRs en el DAG más pequeño que permita paralelismo
real sin solapamiento, fijando paths exclusivos, contratos compartidos,
dependencias, batches paralelos, comandos de verificación y riesgos
que invalidarían el orden. Este documento es el único entregable de
`T-plugin-policy-bootstrap` y no crea tasks hijas en Climier.

## 1. Punto de partida observado

Inspección del repo en `main` (HEAD `3e9ad0e docs: add plugin policy
ADRs`) contra el estado real del código.

- `src/plugin-descriptor.mjs` define `PluginInvalidDescriptor`,
  `PluginLoadFailed`, `validatePluginId`, `validateDescriptor`,
  `readDescriptor` y `importEntry`. `importEntry()` sólo exige
  `default.commands`; la policy es terreno nuevo y se añade sin tocar
  la firma existente (se acepta `default.policy` opcional, ADR-007
  §"Entry único").
- `src/plugin-loader.mjs` expone `loadInstalledPlugin(namespace)` y
  `hasInstalledPlugin(namespace)`, ambos basados en
  `findInstalledDirByCommand` (escaneo de `installed/*/package.json`,
  ADR-005 §"Instalación e identidad"). No existe
  `loadInstalledPolicyPlugins()` ni el lector raw de `.climier.json`
  (ADR-007 §"Discovery global").
- `src/plugin-errors.mjs` define `PluginError`, `PluginLoadFailed`,
  `PluginSubcommandNotFound`, `PluginHandlerFailed`, `PluginAgentMissing`,
  `PluginInvalidDescriptor` (re-export), `throwPluginError`,
  `isPluginError`, y el namespace `PLUGIN_CORE_*` (ADR-006 §"Errores").
  Falta el namespace `POLICY_*` y la clase base `PolicyError` (ADR-007
  §"Errores").
- `src/log.mjs` expone `append()` y `appendWithContext()`. El primero
  mantiene la firma para la ruta CLI normal; el segundo añade
  `plugin_id` cuando `ctx.pluginId` está presente (ADR-006
  §"Locks y logs"). No requiere cambios en este milestone.
- `src/plugin-core-registry.mjs` lista dieciséis operaciones V2
  (`initiative.create`, `task.create/update/take/release/resolve/reopen/cancel`,
  `gate.create/resolve/reopen/cancel`, `knowledge.create/deprecate`,
  `edge.add`, `note.add`). `task.takeover`, `state.restore` y
  `state.init_force` NO se exponen (ADR-008 §"Acciones canónicas").
- `src/plugin-core-adapter.mjs` cablea `createApi({ projectDir, agent,
  pluginId }) → { runtime, query, data, core }` y enruta `core.run({ op,
  input })` a través del registry. No requiere cambios para el seam
  policy; el adapter ya invoca el handler directo (sin rewrap) y
  propaga errores `PLUGIN_*`/`PLUGIN_CORE_*` verbatim.
- `src/commands/*.mjs` (16 mutadores) usan el patrón
  `withLock → readState → updateState → append` (o
  `appendWithContext`). Los 16 mutadores que pasan por el seam son:
  - **Lifecycle**: `take.mjs`, `resolve.mjs`, `release.mjs`, `reopen.mjs`,
    `cancel.mjs`, `add-note.mjs`.
  - **Construcción/edición DAG**: `add-task.mjs`, `add-edge.mjs`,
    `add-node.mjs` (incluye wrappers `add-gate`/`add-knowledge`),
    `add-initiative.mjs`, `update.mjs`, `deprecate-knowledge.mjs`.
  - **Estado**: `restore.mjs`, `init.mjs` (sólo rama `--force`,
    `state.init_force`).
  Cada handler tiene su propia rama de autoridad basada hoy en los
  strings `orchestrator`/`recovery` (take/release/reopen/cancel/restore)
  y un check de flag público `allow-unregistered-initiative`
  (add-task/add-node). El seam debe insertarse dentro de cada
  `withLock`, leyendo el snapshot bajo el lock (ADR-008 §"Seam por
  handler").
- `src/commands/context.mjs` calcula `allowed_actions` con
  `isOrchestrator = agent === "orchestrator"` y emite strings como
  `"release --as orchestrator"` para agentes no-owner. ADR-008
  §"Contexto, help y auditoría" dice que `context.allowed_actions`
  deja de mencionar `orchestrator`/`recovery` y proyecta solo lo que
  invariantes core garantizan.
- `bin/climier.mjs` publica HELP_TEXT con promesas de bypass para
  `orchestrator`/`recovery` ("orchestrator may take over another
  claim", "--as orchestrator|recovery releases any agent's claim") y
  mantiene la lista de comandos core (no toca `allow-unregistered-initiative`
  porque no es comando; es flag de `add-task`/`add-node`).
- `src/commands/reserved-namespaces.mjs` no incluye `orchestrator` ni
  `recovery` (no son comandos); no requiere cambios para los roles.
  Sí requiere cambio para `--allow-unregistered-initiative` (lo
  eliminamos de `knownFlags` en add-task/add-node, no de reserved).
- `src/v2-add-node.mjs` es el wrapper que `add-task`/`add-gate`/
  `add-knowledge` invocan. La función interna `addNodeInternal({ input,
  allowUnregisteredInitiative: true })` (ADR-008 §"Capacidad interna")
  se materializa aquí; el resto del wrapper no cambia.
- `test/` corre `npm test` verde tras los slices V2 previos
  (T-plugin-core-*). Los archivos relevantes para este milestone:
  `test/v2-take-by-id.test.mjs`, `test/v2-lifecycle.test.mjs`,
  `test/v2-context-contract.test.mjs`, `test/v2-initiatives.test.mjs`,
  `test/v2-adversarial.test.mjs`, `test/v2-take.test.mjs`,
  `test/v2-execution-contract.test.mjs`,
  `test/snapshots-restore.test.mjs`, `test/state-snapshots.test.mjs`,
  `test/state-resilience-regression.test.mjs`,
  `test/plugin-compat.test.mjs`, `test/plugin-api.test.mjs`,
  `test/plugin-core-e2e.test.mjs`. Hay dos fixtures V1/V2 ya
  instaladas:
  `test/fixtures/sample-plugin/` y `test/fixtures/core-plugin/`.
  Falta `test/fixtures/plugins/policy-fixture/`.
- `test/helpers.mjs` exige `CLIMIER_HOME` bajo `os.tmpdir()` y rechaza
  el home real. El sandbox `.agents/skills/climier/smoke-sandbox.sh`
  está disponible para mutaciones de smoke. `task-context.sh` y
  `start-worktree.sh` se usan desde el shell del worker; este plan
  no los invoca.

## 2. Mapa de módulos/entrypoints y locks

Texto = estado actual; sufijo `(V2)` = lo que añade este plan.

```text
bin/climier.mjs                              CLI entry; argv + dispatch
                                              (V2: HELP_TEXT y reserved list sin
                                                  "orchestrator may take over";
                                                  reserved-namespaces no cambia)

src/commands/                                25 comandos core (V2: 16 mutadores
                                              adaptan authorizeAction; 2 de
                                              estado — restore + init --force —
                                              usan state.restore y state.init_force)
src/commands/add-task.mjs                    knownFlags sin "allow-unregistered-initiative"
src/commands/add-node.mjs                    knownFlags sin "allow-unregistered-initiative"
                                              (el flag queda en addNodeInternal)

src/policy.mjs                               authorizeAction + selector +
                                              errores POLICY_*  (V2: nuevo)
src/plugin-loader.mjs                        loadInstalledPolicyPlugins +
                                              loadApplicablePolicy        (V2: extensión)
src/plugin-descriptor.mjs                    importEntry valida default.policy opcional
                                              (V2: extensión mínima; la firma
                                              existente se preserva)
src/plugin-errors.mjs                        PolicyError + POLICY_LOAD_FAILED,
                                              POLICY_ERROR, POLICY_DENIED,
                                              POLICY_CONFLICT             (V2: extensión)

src/plugin-core-registry.mjs                 sin cambios (task.takeover,
                                              state.restore y state.init_force
                                              NO se exponen; ADR-008 §"Acciones
                                              canónicas")
src/plugin-core-adapter.mjs                  sin cambios (la registry ya no
                                              expone task.takeover; el seam
                                              policy vive en los handlers)
src/plugin-api.mjs                           sin cambios
src/plugin-dispatch.mjs                      sin cambios (reenvía tokens al
                                              handler; el handler llama el seam)
src/plugin-paths.mjs                         sin cambios
src/plugin-lock.mjs                          sin cambios
src/plugin-runtime.mjs                       sin cambios
src/plugin-query.mjs                         sin cambios
src/plugin-data.mjs                          sin cambios
src/log.mjs                                  sin cambios (appendWithContext
                                              sigue agregando plugin_id cuando
                                              ctx.pluginId está presente)

src/state.mjs                                sin cambios; preserva plugins / nodes[*].plugins
src/lock.mjs                                 sin cambios
src/agent.mjs                                sin cambios (resolveAgent no
                                              inspecciona orchestrator/recovery;
                                              esos strings se eliminan de los
                                              handlers, no del agente)
src/errors.mjs                               sin cambios (POLICY_* se emite
                                              literal desde src/policy.mjs; no
                                              entran en V2_ERROR_CODES — mismo
                                              patrón que PLUGIN_* y PLUGIN_CORE_*)
src/v2-add-node.mjs                          addNodeInternal({ input,
                                              allowUnregisteredInitiative: true })
                                              (V2: función interna)
src/v2.mjs                                   sin cambios

test/                                        suite existente + tests V2 (V2)
test/fixtures/sample-plugin/                 fixture V1 intacta (V2: sin cambios)
test/fixtures/core-plugin/                   fixture V2 intacta (V2: sin cambios)
test/fixtures/plugins/policy-fixture/        fixture V2-policy (V2: nuevo)
                                              — entry con default.policy; expone
                                              applies/authorize/deny/abstain/
                                              throw/slow + namespace plugins.<id>
test/plugin-policy-foundation.test.mjs       tests del contrato, loader y
                                              selector (V2: nuevo)
test/plugin-policy-e2e.test.mjs              fixture + integración e2e del
                                              seam (V2: nuevo)
test/plugin-policy-concurrency.test.mjs      dos takes concurrentes + policy
                                              lenta (V2: nuevo)
test/v2-internal-capabilities.test.mjs       los tres casos del flag interno
                                              (V2: nuevo)
test/v2-take-by-id.test.mjs                  migrar orquestator a fixture (V2)
test/v2-lifecycle.test.mjs                   migrar orquestator a fixture (V2)
test/v2-initiatives.test.mjs                 migrar add-initiative + flag
                                              interno (V2)
test/snapshots-restore.test.mjs              migrar orquestator a fixture (V2)
test/v2-context-contract.test.mjs            adaptar allowed_actions (V2)
test/v2-execution-contract.test.mjs          migrar orquestator a test-agent (V2)
test/v2-take.test.mjs                        sin cambios (no usa roles)
test/v2-add-task-initiative-lookup.test.mjs  migrar orquestator a test-agent (V2)
test/v2-adversarial.test.mjs                 migrar orquestator a fixture (V2)
test/plugin-api.test.mjs                     migrar orquestator a fixture (V2)
test/plugin-compat.test.mjs                  migrar orquestator a fixture (V2)
test/plugin-core-e2e.test.mjs                sin cambios (sólo menciona
                                              "orchestrator" en un comentario
                                              narrativo; no usa el rol)

docs/PLUGINS.md                              contrato policy + seam (V2: extensión)
docs/plans/plugin-policy-execution.md        este plan (V2: nuevo)
.adrs/007-plugin-policy-contract.md          contrato vigente (V2: referencia)
.adrs/008-core-policy-seam.md                seam vigente (V2: referencia)
```

Locks:

| Lock | Path | Scope | Uso |
|---|---|---|---|
| `withLock(projectDir)` | `<state-dir>/.lock` | proyecto | mutadores de estado y `authorizeAction` corre dentro del mismo lock |
| `withGlobalPluginLock` | `<CLIMIER_HOME>/plugins/.lock` | global | `install`/`uninstall` (sin cambios) |

`authorizeAction` corre dentro del `withLock` de cada handler; el
snapshot leído bajo el lock se pasa al plugin, y la policy decide
sobre ese snapshot. Esto no introduce un lock nuevo: el handler ya
posee el lock de proyecto y la policy se ejecuta en su camino
crítico (ADR-008 §"Seam por handler"). El lock global no se ve
afectado: el discovery de policies aplica solo a `install/uninstall`
de policies nuevas, no a la invocación del seam.

## 3. Contratos compartidos que deben preceder consumidores

### 3.1 `default.policy` opcional — extensión de `importEntry`

ADR-007 §"Entry único":

```js
import policy from "./policy.mjs";

export default {
  commands: { /* … */ },
  policy: {
    applies: policy.applies,    // opcional
    authorize: policy.authorize, // obligatorio si default.policy existe
  },
};
```

`importEntry` se extiende para validar la rama `default.policy` cuando
está presente:

- Si `default.policy` existe, debe ser un objeto.
- `policy.authorize` debe ser función si está presente.
- `policy.applies` debe ser función si está presente.
- No se permiten campos adicionales dentro de `policy`
  (ADR-007 §"Entry único").
- Un shape inválido impide cargar el plugin entero, incluido
  `commands`. El error es `PLUGIN_LOAD_FAILED` con `details`
  `{ plugin, entry, field }` (mismo código que ADR-005, sin código
  nuevo para shape; ADR-007 §"Errores" reserva `POLICY_LOAD_FAILED`
  para fallos de runtime del policy ya cargado).

La firma `importEntry(entryAbsPath) → { mod, commands }` se preserva;
el módulo del descriptor agrega `{ policy }` al retorno sólo cuando
está presente, sin romper consumidores V1/V2 (`plugin-loader.mjs`,
`plugin-install.mjs`).

### 3.2 Errores `POLICY_*`

ADR-007 §"Errores" + ADR-008 §"Acciones canónicas". El namespace es
emitido por `src/policy.mjs` y `src/plugin-errors.mjs`, sin pasar por
`V2_ERROR_CODES` (mismo patrón que `PLUGIN_*` y `PLUGIN_CORE_*`).
Cuatro códigos:

- `POLICY_LOAD_FAILED`: shape inválido del entry o del policy al
  cargar (re-uso de `PluginLoadFailed` para no introducir un código
  nuevo en el flujo de install/loader; ADR-007 §"Errores" lo lista
  con `details` `{ plugin, entry, field }`).
- `POLICY_ERROR`: excepción o respuesta inválida en `applies` o
  `authorize` (la policy devolvió algo que no es `{decision}` o
  tiró). `details` `{ plugin_id, op, cause: { code, message,
  details? } }`.
- `POLICY_DENIED`: `decision === "deny"` con `reason`. `details`
  `{ plugin_id, op, action, reason, actor }`. La mutación no se
  ejecuta; el state queda intacto.
- `POLICY_CONFLICT`: dos o más policies aplicables al mismo
  proyecto. `details` `{ plugin_ids: [...], namespaces: [...] }`.

Una denegación o un error nunca permite completar una mutación
(ADR-007 §"Errores"). El seam es responsable de mapear `deny` →
`POLICY_DENIED` y `POLICY_ERROR`/`POLICY_CONFLICT` propagados
verbatim.

### 3.3 Selector y loader global

ADR-007 §"Discovery global" + §"Configuración por proyecto". Tres
helpers nuevos en `src/plugin-loader.mjs`:

```js
// Devuelve { pluginId, descriptor, policy, entryPath, installedDir }
// para TODOS los plugins instalados que exportan `default.policy`.
export async function loadInstalledPolicyPlugins()

// Lee `<project>/.climier.json` raw y devuelve `{}` si no existe.
// El objeto se congela con Object.freeze antes de pasarse a applies.
export async function readProjectConfig(projectDir)

// Devuelve { pluginId, policy, namespace } del único policy aplicable.
// - applies ausente → todos los instalados son candidatos.
// - applies presente → se invoca una vez por candidato con el
//   projectConfig congelado.
// - Más de un candidato que aplica → POLICY_CONFLICT.
// - Ningún candidato → devuelve null (defaults core).
export async function loadApplicablePolicy({ projectDir })
```

`loadApplicablePolicy` se invoca por handler **antes del lock** (la
importación puede ser costosa pero no toca state); el resultado se
pasa al handler como `ctx.policy`. Si devuelve `null`, el handler
actúa con defaults core (abstain global). El policy NO se cachea entre
comandos (ADR-007 §"Discovery global" ítem 5).

### 3.4 `authorizeAction` y el snapshot serializable

ADR-007 §"Contrato de autorización" + ADR-008 §"Invariantes core".

```js
// src/policy.mjs
export async function authorizeAction({
  policy,        // { pluginId, policy: { authorize, applies? }, namespace } | null
  action,        // string canónico (ADR-008 §"Acciones canónicas")
  actor,         // string del --as o CLIMIER_AGENT resuelto por resolveAgent
  target,        // { id, kind, subkind, status?, ... }  ← nodo bajo el lock
  snapshot,      // { state, nodes, edges, initiatives }  ← lectura bajo lock
  projectDir,
  projectConfig, // object congelado de readProjectConfig
})
```

Política del seam:

- Si `policy === null` → `decision: "abstain"` (defaults core).
- Si `policy.policy.authorize` tira → `POLICY_ERROR` con
  `cause.code = "POLICY_ERROR"` y mensaje del plugin. El estado NO
  muta (la policy corre antes de `updateState`; ADR-008 §"Seam por
  handler").
- Si devuelve `{ decision: "allow" }` → mutación procede.
- Si devuelve `{ decision: "deny", reason }` → `POLICY_DENIED`.
- Si devuelve `{ decision: "abstain" }` → defaults core.
- El handler aplica la **tabla por acción** (ADR-008 §"Tabla de take",
  §"Tabla de resolve", §"`restore` e `init --force`"):

  | Acción | allow | deny | abstain |
  |---|---|---|---|
  | `task.take` (libre) | crea claim | `POLICY_DENIED` | crea claim |
  | `task.takeover` (claim ajeno) | reemplaza claim con `previous_owner` | `POLICY_DENIED` | `ALREADY_CLAIMED` |
  | `task.take` mismo actor | idempotente (no hay mutación) | idempotente | idempotente |
  | `task.resolve` no-owner | `NOT_OWNER` (la invariante se evalúa antes del seam; ADR-008 §"Tabla de resolve" ítem 1) | `NOT_OWNER` | `NOT_OWNER` |
  | `task.resolve` owner | resuelve | `POLICY_DENIED` | resuelve |
  | `task.release/cancel/reopen` | muta | `POLICY_DENIED` | defaults por estado (`NOT_OWNER`/`INVALID_STATUS`/idempotente) |
  | `task.update` | muta | `POLICY_DENIED` | muta |
  | `gate.*` | muta | `POLICY_DENIED` | muta (gates no tienen claim lifecycle) |
  | `knowledge.*` | muta | `POLICY_DENIED` | muta |
  | `initiative.create` | muta | `POLICY_DENIED` | muta |
  | `edge.add` | muta | `POLICY_DENIED` | muta |
  | `note.add` | muta | `POLICY_DENIED` | muta |
  | `state.restore` | muta | `POLICY_DENIED` | muta (la pre-snapshot ya fue creada antes de invocar el seam; ver §3.6) |
  | `state.init_force` | muta | `POLICY_DENIED` | muta |

  Esta tabla vive en cada handler; `authorizeAction` sólo materializa
  la decisión. La invariante `task.resolve` → no-owner nunca resuelve
  se aplica **antes** del seam (ADR-008 §"Tabla de resolve" ítem 1).

### 3.5 Acciones canónicas y clasificación

ADR-008 §"Acciones canónicas". Diecinueve acciones:

```text
task.create
task.take
task.takeover        (interno; no se agrega a la registry pública)
task.resolve
task.release
task.reopen
task.cancel
task.update
gate.create
gate.resolve
gate.reopen
gate.cancel
gate.update
knowledge.create
knowledge.deprecate
knowledge.update
initiative.create
edge.add
note.add
state.restore        (interno; no se agrega a la registry pública)
state.init_force     (interno; no se agrega a la registry pública)
```

`update.mjs` clasifica por subkind antes de invocar el seam:
`task.update`, `gate.update`, `knowledge.update`. La registry pública
conserva `task.update` por compatibilidad (ADR-008 §"Acciones
canónicas"). `task.takeover`, `state.restore` y `state.init_force` NO
entran al registry; sólo el seam los conoce.

### 3.6 `restore` e `init --force`

ADR-008 §"`restore` e `init --force`". `restore` no crea pre-snapshot
antes del seam; el orden es:

```text
resolver actor → leer snapshot objetivo (raw + meta) →
withLock →
validar target (sin side effects) →
authorize("state.restore") →
createSnapshot(projectDir, "pre-restore") →
writeState (tmp + rename) →
append log
```

`init --force`:

```text
resolver actor → ensureProjectMeta si falta →
leer projectConfig → withLock →
authorize("state.init_force") →
createSnapshot(projectDir, "force-init") →
writeState fresh
```

Breaking change para scripts actorless de `init --force` (ADR-008
§"`restore` e `init --force`"): `--as` o `CLIMIER_AGENT` es ahora
obligatorio. Documentado en release notes — fuera del scope del plan.

### 3.7 Capacidad interna `addNodeInternal`

ADR-008 §"Capacidad interna". Una sola función:

```js
// src/v2-add-node.mjs (V2)
export async function addNodeInternal({ statePath, flags, positional, pluginId,
                                        allowUnregisteredInitiative = false }) {
  return addNode({
    statePath, flags: { ...flags, "allow-unregistered-initiative": allowUnregisteredInitiative },
    positional, pluginId,
  });
}
```

`add-task`/`add-gate`/`add-knowledge` siguen llamando `addV2Node`
(que delega a `addNode`) para el camino público. La capacidad
`allowUnregisteredInitiative` se fija sólo dentro de `addNodeInternal`;
los wrappers V2 no la exponen. Tests existentes que invocan
`addNode` directo con la flag siguen funcionando mientras el flag
siga siendo un escape interno (la flag se mantiene como propiedad
de `flags` consumida por `add-node.mjs`; lo que se elimina es su
exposición en `knownFlags` de `add-task.mjs`/`add-node.mjs`).

### 3.8 Configuración del proyecto (`plugins.<id>`)

ADR-007 §"Discovery global": el plugin lee su namespace
`plugins[descriptor.id]`. El core no interpreta el payload. La regla
queda codificada en `loadApplicablePolicy`: aplica
`applies(projectConfig)` y el handler no toca `plugins.<id>`.data`
directamente — esa ruta sigue siendo del host V1 (`api.data`).

## 4. Cortes de tasks con paths exclusivos

Seis tasks de implementación, cada una con un único cambio principal,
paths verificables, no-go zones explícitas y comandos de aceptación.
Una task de cierre opcional (`T-plugin-policy-docs`) aparece como
siguiente paso del orquestador tras validar el seam; no se incluye
en este plan porque su contenido es estrictamente documental.

### 4.1 `T-plugin-policy-foundation` — Contrato, loader, selector y errores

- **Cambio principal**: crea `src/policy.mjs` con `authorizeAction`;
  extiende `importEntry` en `src/plugin-descriptor.mjs` para validar
  `default.policy` opcional; agrega `loadInstalledPolicyPlugins`,
  `readProjectConfig` y `loadApplicablePolicy` en `src/plugin-loader.mjs`;
  agrega `PolicyError` y los códigos `POLICY_*` (reutilizando
  `PluginLoadFailed` para el shape; ver §3.2) en `src/plugin-errors.mjs`.
  Tests unitarios de cada helper y de la tabla de acciones (sin
  tocar handlers todavía).
- **Paths propios**:
  - `src/policy.mjs` (nuevo; `authorizeAction`, `loadApplicablePolicy`
    — `loadApplicablePolicy` puede vivir aquí o en
    `src/plugin-loader.mjs`; por consistencia con la separación
    actual — el loader hace I/O y el módulo de policy decide — el
    selector vive en `src/policy.mjs` y consume `loadInstalledPolicyPlugins`
    desde el loader. Esta asignación es fija y la fija el
    orchestrator tras revisar este plan).
  - `src/plugin-loader.mjs` (extensión; añadir
    `loadInstalledPolicyPlugins`, `readProjectConfig`,
    `findInstalledPolicyDirs` — escaneo paralelo a
    `findInstalledDirByCommand`).
  - `src/plugin-descriptor.mjs` (extensión mínima;
    `importEntry` acepta `default.policy` opcional con shape
    estricto; la firma y los returns existentes se preservan).
  - `src/plugin-errors.mjs` (extensión; `PolicyError` y los
    cuatro códigos `POLICY_*`).
  - `test/plugin-policy-foundation.test.mjs` (nuevo; cubre
    shape OK, shape inválido (`authorize` no es función, `applies`
    no es función, campo extra), `loadInstalledPolicyPlugins`
    sobre `installed/*` con y sin `default.policy`,
    `readProjectConfig` con/sin `.climier.json`, congelamiento
    del objeto, `applies` ausente/presente, conflicto,
    `authorizeAction` con policy null y con policy real
    (allow/deny/abstain/throw), tabla por acción
    materializada como función pura a partir del snapshot).
- **No-go zones**: `bin/climier.mjs`, `src/commands/*.mjs`,
  `src/v2-add-node.mjs`, `src/plugin-dispatch.mjs`,
  `src/plugin-api.mjs`, fixtures existentes,
  `docs/PLUGINS.md`, .adrs/, .decisions/.
- **Acceptance**: ver §7.

### 4.2 `T-plugin-policy-fixture` — Fixture V2-policy + tests de seam por handler

- **Cambio principal**: crea la fixture V2-policy
  (`test/fixtures/plugins/policy-fixture/`) con entry que exporta
  `default.policy` (applies + authorize configurables por sub-flag),
  instalable vía `climier install <fixture-dir>`; agrega
  `test/plugin-policy-e2e.test.mjs` que ejercita cada acción canónica
  con cada combinación de decisión (allow/deny/abstain/throw) contra
  el seam **sólo en los handlers que la foundation-task no
  cubre** — esta task cubre los tests de seam por handler que la
  foundation deja pendientes cuando el seam esté cableado.
- **Paths propios**:
  - `test/fixtures/plugins/policy-fixture/package.json` (nuevo;
    descriptor `climier.id = "policy-fixture"`, `command =
    "policy"`, entry autocontenido, **sin** `dependencies` ni
    `devDependencies`).
  - `test/fixtures/plugins/policy-fixture/climier.mjs` (nuevo;
    entrypoint con `default.commands` (no es obligatorio según
    ADR-007 §"Entry único", pero la fixture expone un subcomando
    `apply` para activar la policy vía `applies`) y
    `default.policy = { applies, authorize }`. El comportamiento
    se elige por env vars del sub-comando (no por argv) para no
    contaminar el contrato `applies(projectConfig)` del ADR-007:
    la fixture expone `applies` que devuelve true cuando
    `process.env.POLICY_FIXTURE_APPLY === "true"` en el momento
    de la invocación, y `authorize` que devuelve
    `{decision: "deny"}` cuando `POLICY_FIXTURE_DECISION=deny`,
    `{decision: "allow"}` cuando es `allow`, o tira cuando es
    `throw`. Para `slow` (test de policy lenta), expone un setTimeout
    interno; ADR-008 §"Verificación" no promete timeout dedicado,
    sólo verifica que el lock no se libere durante la policy.
  - `test/helpers.mjs` (extensión opcional; helper
    `installPolicyFixture(projectDir, options)` y
    `uninstallPolicyFixture(projectDir)` que envuelven
    `install <fixture-dir>` con un `CLIMIER_HOME` aislado bajo
    `os.tmpdir()`). Si el helper se prefiere aquí, queda
    **sellado** tras esta task: las tasks posteriores lo consumen
    sin redefinirlo.
  - `test/plugin-policy-e2e.test.mjs` (nuevo; instala la fixture
    vía `installPolicyFixture`, ejecuta `climier <command> ...`
    por CLI con `--as` y verifica envelopes/logs/state por
    combinación de decisión). Por cada acción canónica del ADR-008
    §"Acciones canónicas" excepto `task.takeover`/`state.restore`/
    `state.init_force` (cubiertos en tasks 4.3/4.4/4.5), la
    fixture-based suite verifica: allow muta, deny produce
    `POLICY_DENIED` sin mutar, abstain produce el default core,
    throw produce `POLICY_ERROR` sin mutar.
- **No-go zones**: `src/policy.mjs` (sellado por la foundation),
  `src/plugin-loader.mjs` (sellado), `src/plugin-descriptor.mjs`
  (sellado), `src/plugin-errors.mjs` (sellado), handlers de los
  comandos (sellados en 4.3-4.5 antes de su uso en este test),
  bin, fixtures V1/V2, `docs/PLUGINS.md`.
- **Acceptance**: ver §7.

### 4.3 `T-plugin-policy-seam-lifecycle` — Seam en lifecycle + remoción de roles en esos archivos

- **Cambio principal**: inserta `authorizeAction` en `take.mjs`,
  `resolve.mjs`, `release.mjs`, `reopen.mjs`, `cancel.mjs` y
  `add-note.mjs`. Implementa la clasificación `task.take` /
  `task.takeover` en `take.mjs`. Elimina las comparaciones contra
  los strings `orchestrator`/`recovery` en estos seis archivos.
  En `add-initiative.mjs` agrega el seam con acción `initiative.create`
  **y** la entrada de log que la parity slice omitió
  (`appendWithContext({ agent, action: "add-initiative", node: name },
  { pluginId })`). En `cancel.mjs`/`reopen.mjs`/`release.mjs`, las
  ramas de authority quedan: si policy no aplica (abstain), el
  default core es `NOT_OWNER` para no-owner de un claim
  (`cancel`/`release`), `NOT_OWNER` para no-done_by
  (`reopen`). Las invariantes `task.resolve` → no-owner y el
  idempotente de `release` sin claim se aplican **antes** del seam
  (ADR-008 §"Tabla de resolve").
- **Paths propios**:
  - `src/commands/take.mjs` (extensión; clasifica
    `task.take`/`task.takeover`; elimina `agent !== "orchestrator"`
    y `agent === "orchestrator"`; llama `authorizeAction`).
  - `src/commands/resolve.mjs` (extensión; llama
    `authorizeAction` con `task.resolve`; invariante no-owner
    antes del seam).
  - `src/commands/release.mjs` (extensión; llama
    `authorizeAction` con `task.release`; elimina
    `isOrchestrator`).
  - `src/commands/reopen.mjs` (extensión; llama
    `authorizeAction` con `task.reopen`; elimina
    `isOrchestrator`; invariante no-done_by antes del seam).
  - `src/commands/cancel.mjs` (extensión; llama
    `authorizeAction` con `task.cancel`; elimina
    `isOrchestrator`).
  - `src/commands/add-note.mjs` (extensión; llama
    `authorizeAction` con `note.add`).
  - `src/commands/add-initiative.mjs` (extensión; llama
    `authorizeAction` con `initiative.create`; agrega
    `appendWithContext` con `action: "add-initiative"`).
  - `test/plugin-policy-seam-lifecycle.test.mjs` (nuevo;
    cubre las tablas de `task.take`/`task.takeover`,
    `task.resolve`, `task.release`, `task.reopen`,
    `task.cancel`, `note.add`, `initiative.create` con policy
    ausente/allow/deny/abstain/throw).
- **No-go zones**: `bin/climier.mjs`, `src/commands/context.mjs`
  (cambia en 4.6), `src/commands/restore.mjs`, `src/commands/init.mjs`
  (cambian en 4.5), otros archivos del registry, fixtures V1/V2,
  `docs/PLUGINS.md`, .adrs/.
- **Acceptance**: ver §7.

### 4.4 `T-plugin-policy-seam-dag` — Seam en construcción/edición DAG + remoción de flag + addNodeInternal

- **Cambio principal**: inserta `authorizeAction` en `add-task.mjs`,
  `add-edge.mjs`, `add-node.mjs`, `add-gate.mjs`,
  `add-knowledge.mjs`, `update.mjs`, `deprecate-knowledge.mjs`.
  Implementa la clasificación por subkind en `update.mjs`
  (`task.update`/`gate.update`/`knowledge.update`). Elimina
  `allow-unregistered-initiative` de `knownFlags` en `add-task.mjs`
  y `add-node.mjs`. Crea `addNodeInternal({ input,
  allowUnregisteredInitiative: true })` en `src/v2-add-node.mjs`
  con la firma documentada en §3.7; mantiene `addV2Node`/`addNode`
  intactos para el camino público (la flag ya no se acepta por CLI).
  El check inline de la flag en `add-node.mjs` se conserva
  internamente (lee `flags["allow-unregistered-initiative"]` cuando
  `addNodeInternal` la fija); ningún wrapper público la expone.
- **Paths propios**:
  - `src/commands/add-task.mjs` (extensión; elimina
    `"allow-unregistered-initiative"` de `knownFlags`; llama
    `authorizeAction` con `task.create`).
  - `src/commands/add-edge.mjs` (extensión; llama
    `authorizeAction` con `edge.add`).
  - `src/commands/add-node.mjs` (extensión; elimina
    `"allow-unregistered-initiative"` de `knownFlags`; llama
    `authorizeAction` con la acción clasificada por subkind).
  - `src/commands/add-gate.mjs` (extensión; llama
    `authorizeAction` con `gate.create`; el resto del cuerpo
    queda igual — la flag no estaba en su `knownFlags`).
  - `src/commands/add-knowledge.mjs` (extensión; llama
    `authorizeAction` con `knowledge.create`).
  - `src/commands/update.mjs` (extensión; clasifica por
    subkind y llama `authorizeAction` con `task.update`,
    `gate.update` o `knowledge.update`).
  - `src/commands/deprecate-knowledge.mjs` (extensión; llama
    `authorizeAction` con `knowledge.deprecate`).
  - `src/v2-add-node.mjs` (extensión; exporta
    `addNodeInternal` con la firma §3.7).
  - `test/plugin-policy-seam-dag.test.mjs` (nuevo; cubre las
    tablas de cada acción DAG con policy
    ausente/allow/deny/abstain/throw; verifica que
    `addNodeInternal({ allowUnregisteredInitiative: true })`
    bypassa `INITIATIVE_NOT_FOUND`).
- **No-go zones**: `bin/climier.mjs` (HELP_TEXT cambia en 4.6),
  `src/commands/context.mjs` (cambia en 4.6), `src/commands/restore.mjs`,
  `src/commands/init.mjs`, otros lifecycle (cambian en 4.3),
  fixtures V1/V2, `docs/PLUGINS.md`, .adrs/.
- **Acceptance**: ver §7.

### 4.5 `T-plugin-policy-seam-state-ops` — Seam en `restore` e `init --force`

- **Cambio principal**: inserta `authorizeAction` en `restore.mjs`
  con acción `state.restore` y en `init.mjs` con acción
  `state.init_force` (sólo cuando `flags.force === true`). Elimina
  la comparación `as !== "orchestrator" && as !== "recovery"` en
  `restore.mjs`: el seam decide; con policy ausente o abstain, el
  handler aún exige `as` no vacío (`resolveAgent` ya rechaza
  vacío) pero NO compara contra roles. La pre-snapshot en
  `restore.mjs` se mueve **después** del seam (ADR-008 §"`restore`
  e `init --force`"); la rama `force-init`/`corrupt-recovery` en
  `init.mjs` se mueve **después** del seam y de `ensureProjectMeta`
  + lectura de projectConfig.
- **Paths propios**:
  - `src/commands/restore.mjs` (extensión; llama
    `authorizeAction` con `state.restore` después de validar el
    target raw+meta; crea pre-snapshot **después** del seam;
    elimina `as !== "orchestrator" && as !== "recovery"`).
  - `src/commands/init.mjs` (extensión; rama `--force` llama
    `authorizeAction` con `state.init_force` después de
    `ensureProjectMeta` y lectura de projectConfig; rama sin
    `--force` queda fuera del seam porque es bootstrap puro).
  - `test/plugin-policy-seam-state-ops.test.mjs` (nuevo; cubre
    `state.restore` allow/deny/abstain/throw con pre-snapshot
    creado/no creado según decisión; cubre
    `state.init_force` allow/deny/abstain/throw; verifica que
    `init` sin `--force` no pasa por el seam; verifica que un
    deny no deja pre-snapshot huérfano).
- **No-go zones**: `bin/climier.mjs`, `src/commands/context.mjs`
  (cambia en 4.6), lifecycle y DAG (sellados por 4.3 y 4.4),
  fixtures V1/V2, `docs/PLUGINS.md`, .adrs/.
- **Acceptance**: ver §7.

### 4.6 `T-plugin-policy-removal-context-help` — Limpieza de help, allowed_actions y migración de tests documentales

- **Cambio principal**: actualiza `bin/climier.mjs` HELP_TEXT y
  `src/commands/context.mjs` `allowed_actions` para reflejar que
  no hay promesas de bypass por roles (ADR-008 §"Contexto, help y
  auditoría"). Elimina la rama `isOrchestrator` en `context.mjs`
  y los strings `"release --as orchestrator"` (la rama del no-owner
  ahora dice `"release"` plano cuando no hay claim propio — el
  seam decidirá si la policy lo permite). Actualiza `docs/PLUGINS.md`
  para documentar el contrato policy + seam y la lista de acciones
  canónicas. Hace una pasada de grep documentada (commit body)
  para confirmar que no quedan hatches `orchestrator`/`recovery` en
  código de runtime ni menciones del flag
  `--allow-unregistered-initiative` en help/registry/inputs de
  plugins. Si encuentra residuos, los reporta como riesgo al
  orquestador (no los corrige si están fuera de su ownership).
- **Paths propios**:
  - `bin/climier.mjs` (extensión; HELP_TEXT sin "orchestrator may
    take over another claim", sin "--as orchestrator|recovery
    releases any agent's claim", sin `--allow-unregistered-initiative`
    en descripciones).
  - `src/commands/context.mjs` (extensión; `allowedActions`
    elimina `isOrchestrator` y los strings
    `"release --as orchestrator"`).
  - `docs/PLUGINS.md` (extensión; contrato policy + seam;
    referencia a ADR-007 y ADR-008).
  - `test/v2-context-contract.test.mjs` (extensión; adapta los
    tres casos que esperan `"release --as orchestrator"` o que
    inspeccionan `isOrchestrator`).
- **No-go zones**: lifecycle, DAG y state-ops (sellados), src/policy,
  plugin-loader, fixtures V1/V2, .adrs/, .decisions/.
- **Acceptance**: ver §7.

### 4.7 `T-plugin-policy-migration-tests` — Migración de tests de roles al fixture + nuevos tests

- **Cambio principal**: migra los tests existentes que dependen de
  roles `orchestrator`/`recovery` para usar la fixture policy cuando
  el caso prueba bypass/ownership, o `test-agent` cuando el uso es
  puramente nominal (`add-initiative`, `execution-contract`,
  `add-task-initiative-lookup`). Crea `test/v2-internal-capabilities.test.mjs`
  con los tres casos del flag interno
  (`allow-unregistered-initiative`) movidos desde
  `v2-initiatives.test.mjs`. Crea
  `test/plugin-policy-concurrency.test.mjs` con dos takes
  concurrentes (uno gana `task.take` allow, otro recibe
  `task.takeover` con allow/deny/abstain) y con policy lenta
  (verifica que el `withLock` no se libera durante la policy y que
  el segundo take espera).
- **Paths propios**:
  - `test/v2-take-by-id.test.mjs` (migración; "orchestrator
    takes over another agent's in-progress task" → escenario con
    la fixture: primer take por agent-a, segundo take por agent-b
    dispara `task.takeover` con policy allow/deny/abstain).
  - `test/v2-lifecycle.test.mjs` (migración; release/reopen/cancel
    con `as: "orchestrator"`/`as: "recovery"` → casos con la
    fixture).
  - `test/v2-initiatives.test.mjs` (migración; los casos que
    usan `--allow-unregistered-initiative` se borran de aquí y
    pasan al nuevo `v2-internal-capabilities.test.mjs`).
  - `test/snapshots-restore.test.mjs` (migración; restore con
    `as: "orchestrator"`/`as: "recovery"` → casos con la fixture
    y casos nominales con `test-agent` para no-policy).
  - `test/v2-adversarial.test.mjs` (migración; el caso
    `as: "orchestrator"` en take → escenario con la fixture).
  - `test/v2-add-task-initiative-lookup.test.mjs` (migración
    nominal; `as: "orchestrator"` → `as: "test-agent"`).
  - `test/v2-execution-contract.test.mjs` (migración nominal;
    `as: "orchestrator"` → `as: "test-agent"` para casos que
    no prueban policy).
  - `test/plugin-api.test.mjs` (migración; el caso
    `as: "orchestrator"` con policy ausente → escenario con la
    fixture; cualquier `as: "orchestrator"` nominal → `test-agent`).
  - `test/plugin-compat.test.mjs` (migración nominal;
    `as: "orchestrator"` para casos no-policy → `test-agent`).
  - `test/plugin-core-e2e.test.mjs` (sin cambios; los matches
    son sólo comentarios narrativos).
  - `test/v2-internal-capabilities.test.mjs` (nuevo; tres casos
    del flag interno: add-node con flag vía
    `addNodeInternal({ allowUnregisteredInitiative: true })`,
    add-task por CLI con la flag rechazada como unknown flag,
    add-task por CLI sin flag con `INITIATIVE_NOT_FOUND`).
  - `test/plugin-policy-concurrency.test.mjs` (nuevo; dos
    `child_process` con `CLIMIER_HOME` compartido — uno ejecuta
    el fixture (policy allow), el otro corre `climier take`
    por CLI; verifica que el estado final es íntegro, que
    `plugin_id` aparece sólo en entradas del plugin, que no
    hay interleavings; segundo caso: dos `climier take`
    simultáneos sobre la misma task → uno gana `task.take`,
    el otro dispara `task.takeover` con policy
    allow/deny/abstain; policy lenta verifica que el lock
    persiste hasta el retorno de `authorizeAction`).
- **No-go zones**: src/, bin/, fixtures V1/V2, docs/, .adrs/,
  .decisions/. Las migraciones no tocan los handlers ya sellados.
- **Acceptance**: ver §7.

## 5. DAG y dependencias

```text
                            T-plugin-policy-bootstrap
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
       T-plugin-policy-foundation   T-plugin-policy-fixture
                  │                       │
                  └───────────┬───────────┘
                              ▼
                  ┌───────────�───────────┐
                  ▼                       ▼
   T-plugin-policy-seam-lifecycle  T-plugin-policy-seam-dag
                  │                       │
                  └───────────┬───────────┘
                              ▼
                  T-plugin-policy-seam-state-ops
                              │
                              ▼
                  T-plugin-policy-removal-context-help
                              │
                              ▼
                  T-plugin-policy-migration-tests
```

Tabla de dependencias:

| Task | Bloqueada por |
|---|---|
| `T-plugin-policy-foundation` | `T-plugin-policy-bootstrap` |
| `T-plugin-policy-fixture` | `T-plugin-policy-bootstrap` |
| `T-plugin-policy-seam-lifecycle` | `T-plugin-policy-bootstrap`, `T-plugin-policy-foundation`, `T-plugin-policy-fixture` |
| `T-plugin-policy-seam-dag` | `T-plugin-policy-bootstrap`, `T-plugin-policy-foundation`, `T-plugin-policy-fixture` |
| `T-plugin-policy-seam-state-ops` | `T-plugin-policy-bootstrap`, `T-plugin-policy-foundation`, `T-plugin-policy-seam-lifecycle` (necesita que add-initiative cierre su log entry), `T-plugin-policy-fixture` |
| `T-plugin-policy-removal-context-help` | `T-plugin-policy-bootstrap`, `T-plugin-policy-seam-lifecycle`, `T-plugin-policy-seam-dag`, `T-plugin-policy-seam-state-ops` |
| `T-plugin-policy-migration-tests` | `T-plugin-policy-bootstrap`, `T-plugin-policy-seam-lifecycle`, `T-plugin-policy-seam-dag`, `T-plugin-policy-seam-state-ops`, `T-plugin-policy-removal-context-help` |

Todas las tasks hijas emiten `BLOCKS` con `from: <padre>, to: <hija>`
hacia la dependencia. La dirección canónica del ADR se respeta: el
blocker es el origen, el bloqueado es el destino.

## 6. Batches paralelos

Después de que `T-plugin-policy-bootstrap` quede resuelta:

- **Batch A (2 workers en paralelo)**:
  - `T-plugin-policy-foundation` (extiende tres módulos de plugin
    host — `src/policy.mjs`, `src/plugin-loader.mjs`,
    `src/plugin-descriptor.mjs`, `src/plugin-errors.mjs` — y crea
    `test/plugin-policy-foundation.test.mjs`; no toca handlers,
    bin, fixtures V1/V2, ni docs).
  - `T-plugin-policy-fixture` (crea `test/fixtures/plugins/policy-fixture/`,
    extiende opcionalmente `test/helpers.mjs` con
    `installPolicyFixture`, y crea `test/plugin-policy-e2e.test.mjs`;
    no toca `src/`, ni `bin/`, ni fixtures V1/V2).
  - **Sin conflicto**: paths disjuntos por construcción. La
    foundation lee `src/plugin-loader.mjs` para extenderla; la
    fixture task no abre `src/`.

- **Batch B (2 workers en paralelo, requiere Batch A cerrado)**:
  - `T-plugin-policy-seam-lifecycle` (toca seis archivos de
    `src/commands/` y `src/commands/add-initiative.mjs`; crea
    `test/plugin-policy-seam-lifecycle.test.mjs`).
  - `T-plugin-policy-seam-dag` (toca siete archivos de
    `src/commands/`, `src/v2-add-node.mjs`; crea
    `test/plugin-policy-seam-dag.test.mjs`).
  - **Sin conflicto**: los dos batches tocan archivos disjuntos.
    `lifecycle` toca `{take,resolve,release,reopen,cancel,add-note,add-initiative}.mjs`;
    `dag` toca `{add-task,add-edge,add-node,add-gate,add-knowledge,update,deprecate-knowledge}.mjs`
    y `src/v2-add-node.mjs`. Ningún path compartido.

- **Batch C (1 worker, requiere Batch B cerrado)**:
  - `T-plugin-policy-seam-state-ops` (toca `restore.mjs`,
    `init.mjs`; crea `test/plugin-policy-seam-state-ops.test.mjs`).

- **Batch D (1 worker, requiere Batch C cerrado)**:
  - `T-plugin-policy-removal-context-help` (toca `bin/climier.mjs`,
    `src/commands/context.mjs`, `docs/PLUGINS.md`,
    `test/v2-context-contract.test.mjs`).

- **Batch E (1 worker, requiere Batch D cerrado)**:
  - `T-plugin-policy-migration-tests` (migración de tests de roles;
    crea `test/v2-internal-capabilities.test.mjs` y
    `test/plugin-policy-concurrency.test.mjs`).

No hay task de integración dedicada: el seam es un cambio aditivo
que respeta la firma de los handlers, y los tests de cada slice ya
cubren la integración por handler. La verificación global del ADR
(§7) corre la suite completa para confirmar que el conjunto cierra
sin regresiones entre slices.

## 7. Comandos de verificación

Cada task debe pasar, en orden:

| Task | Comando |
|---|---|
| `T-plugin-policy-foundation` | `node --test test/plugin-policy-foundation.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-fixture` | `node --test test/plugin-policy-e2e.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-seam-lifecycle` | `node --test test/plugin-policy-seam-lifecycle.test.mjs`, `node --test test/plugin-policy-e2e.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-seam-dag` | `node --test test/plugin-policy-seam-dag.test.mjs`, `node --test test/plugin-policy-e2e.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-seam-state-ops` | `node --test test/plugin-policy-seam-state-ops.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-removal-context-help` | `node --test test/v2-context-contract.test.mjs`, `npm test`, `grep -rn "orchestrator\\\|recovery\\\|allow-unregistered-initiative" bin/ src/commands/ src/policy.mjs src/plugin-loader.mjs src/plugin-descriptor.mjs src/plugin-errors.mjs docs/PLUGINS.md 2>/dev/null` (debe ser vacío o documentado en commit body) |
| `T-plugin-policy-migration-tests` | `node --test test/plugin-policy-concurrency.test.mjs`, `node --test test/v2-internal-capabilities.test.mjs`, `npm test`, `git diff --check` |

Verificación global del ADR:

```bash
node --test test/plugin-policy-foundation.test.mjs \
         test/plugin-policy-e2e.test.mjs \
         test/plugin-policy-seam-lifecycle.test.mjs \
         test/plugin-policy-seam-dag.test.mjs \
         test/plugin-policy-seam-state-ops.test.mjs \
         test/v2-internal-capabilities.test.mjs \
         test/plugin-policy-concurrency.test.mjs
npm test
```

Concurrencia (`npm run test:concurrent` cuando exista, o el patrón
`child_process` ya presente en `test/plugin-core-concurrency.test.mjs`):

```bash
node --test test/plugin-core-concurrency.test.mjs \
         test/plugin-policy-concurrency.test.mjs \
         test/v2-take-by-id.test.mjs \
         test/v2-lifecycle.test.mjs \
         test/v2-take.test.mjs
```

Smoke manual del ADR (cubierto por los tests de seam):

1. Instalar `test/fixtures/plugins/policy-fixture/` desde path local.
2. `applies` ausente → todos los instalados son candidatos; si sólo
   hay uno, se selecciona.
3. `applies` presente y devuelve `false` → no se selecciona, defaults
   core.
4. `applies` presente y devuelve `true` → se selecciona.
5. Más de una policy aplicable → `POLICY_CONFLICT`.
6. `authorize` devuelve `allow` → muta.
7. `authorize` devuelve `deny` con `reason` → `POLICY_DENIED`, state
   intacto, log sin entry de éxito.
8. `authorize` tira → `POLICY_ERROR`, state intacto.
9. `authorize` devuelve `abstain` → defaults core.
10. Takeover: agent-a claimed, agent-b take → `task.takeover`;
    policy allow reemplaza claim con `previous_owner`;
    policy deny `POLICY_DENIED`; policy abstain `ALREADY_CLAIMED`.
11. `task.resolve` por no-owner → `NOT_OWNER` aunque policy devuelva
    `allow` (invariante previa al seam).
12. `restore` con policy deny → no crea pre-snapshot huérfano.
13. `init --force` con policy deny → state intacto, sin
    pre-snapshot huérfano.
14. `init --force` actorless (sin `--as`/`CLIMIER_AGENT`) →
    `MISSING_AGENT` (breaking change documentado en release notes).
15. CLI `--allow-unregistered-initiative` → unknown flag.

## 8. Riesgos que invalidarían el orden

1. **Seam sin foundation.** Si `T-plugin-policy-seam-lifecycle` o
   `T-plugin-policy-seam-dag` corren antes que
   `T-plugin-policy-foundation`, no existe `authorizeAction` ni
   `loadApplicablePolicy`. Mitigado: dependencia explícita en §5 y
   batch ordering §6.

2. **Fixture sin foundation.** Si los tests de `T-plugin-policy-fixture`
   corren contra una policy que `importEntry` rechaza porque la
   rama `default.policy` no está validada, el fixture se cae con
   `PLUGIN_LOAD_FAILED` antes de que ningún handler pueda probar
   el seam. Mitigado: dependencia explícita en §5.

3. **Lifecycle sin fixture.** Si `T-plugin-policy-seam-lifecycle`
   corre sin `T-plugin-policy-fixture`, los tests del seam de
   lifecycle no pueden ejercitar allow/deny/abstain/throw porque
   la fixture provee esos modos. Mitigado: dependencia §5 y
   el worker que ejecuta la tarea de lifecycle espera a la
   foundation + fixture antes de empezar.

4. **DAG sin fixture.** Idem riesgo 3 para los handlers DAG.
   Mitigado: dependencia §5.

5. **State-ops sin lifecycle.** `T-plugin-policy-seam-state-ops`
   depende de que `add-initiative` haya cerrado su entrada de log
   (la parity slice V2 la omitió; §4.3 lo agrega). Si state-ops
   corre antes que lifecycle, `add-initiative` no loguea y
   `init --force` no puede verificar la entrada de log en tests.
   Mitigado: dependencia §5.

6. **Remoción antes del seam.** Si
   `T-plugin-policy-removal-context-help` corre antes de los
   seams, `take.mjs` queda sin `isOrchestrator` y sin `seam` →
   `take` de un no-owner por un agente sin claim previo devuelve
   `NOT_READY` en lugar de `ALREADY_CLAIMED`. Mitigado:
   dependencia §5; los seams corren antes que la remoción.

7. **Migración de tests antes del seam.** Si
   `T-plugin-policy-migration-tests` corre antes de los seams, los
   tests migrados no pueden usar la fixture porque ningún handler
   la invoca. Mitigado: dependencia §5.

8. **`addNodeInternal` con flag pública.** Si la tarea de DAG
   agrega `addNodeInternal` pero deja
   `"allow-unregistered-initiative"` en `knownFlags` de
   `add-task.mjs`/`add-node.mjs`, la flag sigue siendo pública y
   rompe el contrato ADR-008 §"Capacidad interna". Mitigado: §4.4
   exige eliminar la flag de `knownFlags`; el grep final de §7 lo
   verifica.

9. **Lock global cruzado.** Si `install` de la fixture o de un
   policy plugin corre mientras un handler de seam está bajo
   `withLock(projectDir)`, los dos locks son disjuntos (§2) y no
   hay bloqueo cruzado. Mitigado: el lock global sigue siendo de
   install/uninstall; el seam no lo toca.

10. **Policy lenta sin timeout.** ADR-008 §"Verificación" promete
    que el lock persiste durante la policy. Si `authorizeAction`
    hace `await` sobre una policy que retorna después de N
    segundos, el lock de proyecto se mantiene N segundos; el
    segundo take espera. No hay timeout dedicado (fuera de scope,
    ADR-008 §"Negativas" + §"Plan por piezas" 8). Mitigado: el
    test `plugin-policy-concurrency.test.mjs` mide el tiempo y
    verifica que el lock se libera sólo después del retorno de la
    policy.

11. **Plugin tira `default.policy` por error de typo.** Si el
    fixture exporta `default.policy.apply` (typo) en lugar de
    `default.policy.authorize`, `importEntry` rechaza con
    `PLUGIN_LOAD_FAILED` (no carga el plugin). Mitigado: la
    foundation task verifica shape y rechaza `authorize` ausente;
    la fixture task valida que su descriptor pasa esa validación
    antes de empezar los tests.

12. **Compatibilidad de V2 ya mergeado.** ADR-006 ya está
    mergeado; las dieciséis ops viven en la registry pública.
    El seam policy es ortogonal: los handlers que V2 invoca
    siguen llamando al seam, y el seam no modifica la firma de
    `core.run`. La superficie V2 (`api.core.version === 2`,
    `api.core.run({ op, input })`) no cambia. Mitigado: el plan
    no toca `src/plugin-core-registry.mjs`,
    `src/plugin-core-adapter.mjs` ni `src/plugin-api.mjs`.

13. **`context.allowed_actions` ya consumido por la UI.** Si la UI
    lee `release --as orchestrator` y la remoción lo elimina,
    la UI debe actualizarse. Mitigado: la UI consume
    `allowed_actions` pero no filtra por string exacto; renderiza
    la lista como acciones sugeridas. Si la UI mostraba la string,
    queda como un follow-up fuera del scope del plan (la UI vive
    en `ui/` y es un subproyecto; ver `AGENTS.md`).

14. **`init --force` actorless en scripts.** ADR-008 §"`restore`
    e `init --force`" marca esto como breaking change
    documentado en release notes. Scripts CI o recovery tooling
    que llamaban `init --force` sin `--as`/`CLIMIER_AGENT`
    fallarán con `MISSING_AGENT`. Mitigado: el plan documenta el
    cambio; los tests `plugin-policy-seam-state-ops.test.mjs`
    verifican el nuevo comportamiento y no reintroducen el bypass.

15. **`appendWithContext` ya en uso por V2.** El seam de logs V2
    ya inyecta `plugin_id` cuando `ctx.pluginId` está presente.
    El seam policy no toca `src/log.mjs`; el contrato de
    `appendWithContext` no cambia. Mitigado: §2 y §4.3 mencionan
    el uso en `add-initiative.mjs` para cerrar el gap de la parity
    slice V2.

## 9. Decisiones explícitas

- **No se introduce composición de policies.** ADR-007 §"Decisión"
    explícitamente descarta composición para esta versión; el
    selector devuelve `null` cuando más de una policy aplica
    (`POLICY_CONFLICT`). El plan respeta este recorte y no
    propone task de composición.

- **No se introduce autenticación.** ADR-007 §"Decisión"
    `actor` es exactamente `actor_id` (`--as`/`CLIMIER_AGENT`), no
    autenticación. El plan no agrega auth, secrets, ni firma.

- **No se introduce sandboxing.** ADR-007 §"Decisión" dice
    "La escritura directa de archivos core por plugins queda
    prohibida por contrato; no se promete sandboxing." El plan no
    propone task de sandbox ni de aislamiento de procesos.

- **No se introduce timeout dedicado.** ADR-008 §"Negativas" lo
    confirma. La policy lenta se prueba para verificar que el
    lock persiste, no para acotar el tiempo.

- **No se introduce auditoría persistente.** ADR-008 §"Contexto,
    help y auditoría" dice que las denegaciones no agregan eventos
    al state log en esta fase. El plan respeta el recorte: el
    `POLICY_DENIED` se devuelve como error JSON; no se loguea
    una entrada `policy-deny` en `state.log`.

- **El selector vive en `src/policy.mjs`.** La foundation propone
    que `loadApplicablePolicy` viva en `src/policy.mjs` (módulo
    nuevo) y consuma `loadInstalledPolicyPlugins` desde
    `src/plugin-loader.mjs`. Esta asignación es fija: el
    orchestrator la respeta en la task de foundation. Si un
    revisor la cambia, debe actualizar este plan antes de crear
    la task.

- **El seam corre dentro del lock.** ADR-008 §"Seam por handler".
    El `withLock` ya está tomado por el handler cuando se invoca
    `authorizeAction`. La selección/import de policy puede ocurrir
    antes del lock (costosa pero no mutante); la decisión no: el
    snapshot leído bajo el lock se pasa al plugin. ADR-008 §"Seam
    por handler".

- **`task.takeover`/`state.restore`/`state.init_force` no se
    agregan a la registry pública.** Sólo el seam los conoce. El
    adapter V2 no las expone.

- **`update.mjs` clasifica por subkind.** La registry pública
    conserva `task.update` por compatibilidad (ADR-008 §"Acciones
    canónicas"); el handler clasifica internamente y pasa la
    acción correcta al seam.

- **`init` sin `--force` queda fuera del seam.** ADR-008 §"`restore`
    e `init --force`" sólo mete `init --force` en el camino del
    seam; `init` normal es bootstrap puro y no muta datos del
    usuario. El handler agrega una rama explícita: si
    `flags.force !== true`, no se invoca `authorizeAction`.

- **`add-initiative.mjs` agrega entrada de log.** §4.3 lo hace
    como parte del seam de lifecycle. Esto cierra un gap real de
    la parity slice V2 (que omitió el log en este handler). Es un
    one-liner; si la parity slice lo hubiera hecho, este plan no
    lo mencionaría. La decisión es fija: el log de `add-initiative`
    queda.

- **`addNodeInternal` vive en `src/v2-add-node.mjs`.** §3.7 lo
    fija. El wrapper público `addV2Node` no cambia; la función
    interna sólo es accesible vía import directo para tests de
    internal capabilities.

- **`add-node.mjs` mantiene la lectura interna de la flag.**
    §3.7. `addNodeInternal` fija `flags["allow-unregistered-initiative"]`
    en el objeto que pasa a `addNode`; el check inline en
    `add-node.mjs` (línea ~112 actual) lee el flag del objeto y
    respeta el bypass. Ningún wrapper público expone la flag.

- **El helper `installPolicyFixture` vive en `test/helpers.mjs`.**
    §4.2. Si la fixture task decide no tocar `test/helpers.mjs`,
    puede definirlo localmente en `test/plugin-policy-e2e.test.mjs`;
    la decisión queda en manos del worker. El plan asume la
    opción `helpers.mjs` para evitar duplicación entre e2e y
    concurrency.

- **`docs/PLUGINS.md` se actualiza en la task 4.6.** El contrato
    policy + seam se documenta ahí, no en `docs/PLUGINS.md` ni en
    un doc nuevo. ADR-007 §"Decisión" no pide doc separado.

- **La UI no se toca.** `ui/` es subproyecto y consume `allowed_actions`
    como strings. Si la remoción de `"release --as orchestrator"`
    rompe algo, es follow-up fuera del scope.

- **No se commitea nada fuera de `docs/plans/plugin-policy-execution.md`**
    por el worker que ejecuta este bootstrap. El cierre de
    `T-plugin-policy-bootstrap` deja: este plan commiteado, las
    siete tasks propuestas para que el orchestrator las cree en
    Climier tras validar el documento, y una nota de cierre con
    los ids y el orden propuesto.

## 10. Lo que esta task no hace

- No implementa `src/policy.mjs` (lo delegará a
  `T-plugin-policy-foundation`).
- No crea la fixture V2-policy (lo delegará a
  `T-plugin-policy-fixture`).
- No modifica `bin/climier.mjs`, `src/commands/*.mjs`,
  `src/v2-add-node.mjs`, `src/plugin-loader.mjs`,
  `src/plugin-descriptor.mjs`, `src/plugin-errors.mjs`,
  `src/plugin-core-registry.mjs`, `src/plugin-core-adapter.mjs`,
  `src/plugin-api.mjs`, `src/plugin-dispatch.mjs`, `src/log.mjs`,
  `src/state.mjs`, `src/lock.mjs`, `src/agent.mjs`,
  `src/errors.mjs`, `src/v2.mjs`, `src/v2-add-node.mjs` (excepto
  la firma interna `addNodeInternal`, que es de la task
  `T-plugin-policy-seam-dag`).
- No modifica fixtures V1/V2 (`test/fixtures/sample-plugin/`,
  `test/fixtures/core-plugin/`).
- No modifica `docs/PLUGINS.md` (la actualización es de la task
  `T-plugin-policy-removal-context-help`).
- No crea plugins de producto.
- No resuelve gates ni delega workers.
- No commitea nada fuera de `docs/plans/plugin-policy-execution.md`.

El cierre de `T-plugin-policy-bootstrap` deja: este plan
commiteado, siete tasks propuestas para que el orchestrator las
cree en Climier tras validar el documento, y una nota de cierre con
los ids y el orden propuesto.
