# RFC: Graph Kernel y providers internos de Climier

- Gate: `G-graph-kernel-providers-rfc`
- Iniciativa: `plugin-platform`
- Estado: aprobado para derivación de ADR y bootstrap de ejecución
- Autor: orchestrator

## Resumen

Refactorizar Climier para separar un kernel básico de grafos de los módulos que
aportan semántica de dominio. El kernel será la **única frontera autorizada para
leer y mutar el estado**: nodes, edges, revisiones, locks, persistencia atómica,
logs y snapshots.

`task`, `gate`, `knowledge` y `policy` serán providers internos. Un provider
conoce la semántica de su dominio, pero nunca edita `tasks.json`, toma locks,
actualiza directamente el estado ni escribe logs por fuera del kernel.

Las operaciones agent-facing que modifican un nodo existente deben recibir la
revisión esperada del agente. El provider define cuándo esa revisión es
obligatoria; el kernel ofrece la comparación atómica, la ejecuta bajo lock y
rechaza una operación obsoleta sin escribir. El kernel no obliga a toda mutación
interna a recibir una revisión.

`node.revision` se mantiene como mecanismo activo del estado v2. No se elimina ni
se marca deprecated en esta release. El kernel es su único dueño y aumenta la
revisión exactamente una vez por cada nodo existente que una operación exitosa
modifica. Una release futura podrá revisar este mecanismo por separado, pero no es
parte de este refactor.

No se garantiza compatibilidad con plugins externos antiguos. No existen plugins
instalados que deban preservarse, por lo que el contrato de plugins, la forma del
registry y los adapters pueden rediseñarse según esta arquitectura. Se conserva
el nombre `api.core.run` como fachada programática para el contrato nuevo, pero no
se promete compatibilidad de inputs, outputs o implementación con plugins viejos.

La separación fundamental es:

```text
CLI / API / plugin
        ↓
adapter o dispatcher del host
        ↓
operation registry
        ↓
provider de task/gate/knowledge/policy
        ↓
frontera de mutación del Graph Kernel
        ↓
state v2 + log + snapshots
```

`task.create` es una operación del task provider. No es una primitiva que el
kernel deba conocer como semántica de task. Todo pasa por el kernel para
persistirse de forma segura, pero el kernel no incorpora las reglas específicas
de cada dominio.

## Decisiones de alcance

Esta fase mantiene el schema core v2 y la semántica del grafo, pero permite
cambios deliberados en el contrato de plugins y en la interfaz agent-facing de
modificaciones:

- `version: 2` y la forma core de `nodes`, `edges`, `initiatives` y `log` se
  conservan;
- `node.revision` permanece activo y es administrado exclusivamente por el
  kernel;
- las operaciones agent-facing sobre nodos existentes deben enviar una revisión
  esperada;
- `before/after` no forma parte de la nueva interfaz;
- el kernel acepta precondiciones de revisión opcionales para operaciones internas
  confiables;
- cada mutación exitosa que cambia un nodo existente incrementa su revisión una
  vez;
- `task.create` puede crear un nodo y sus edges `BLOCKS` en una sola mutación;
- no hay compatibilidad obligatoria con plugins externos antiguos;
- `api.core.run({ op, input })` se conserva como nombre de fachada para plugins
  nuevos, pero su contrato puede ser rediseñado;
- no se agregan tipos de nodo externos ni campos obligatorios nuevos en el
  estado v2.

## Motivación

El estado ya tiene una forma de grafo (`nodes`, `edges`, `initiatives`, `log`),
pero el código mezcla varias responsabilidades:

- `add-node` conoce la estructura genérica y también task/gate/knowledge;
- `v2.mjs` contiene validación de edges, derivación, satisfacción y scopes;
- `status` y `context` discriminan directamente los tipos de nodo;
- los comandos de lifecycle implementan semántica específica y persistencia;
- `plugin-core-registry.mjs` mantiene una lista fija de operaciones;
- `src/policy.mjs` centraliza la selección y autorización de policies, pero los
  handlers coordinan directamente la mutación;
- la revisión está modificada manualmente por varios handlers;
- plugin data y otras mutaciones tienen rutas de persistencia propias.

Ese acoplamiento hace que un plugin pueda consumir algunas acciones core, pero no
exista una frontera única donde pasen todas las lecturas/mutaciones ni una
arquitectura común para que providers internos y plugins nuevos publiquen y
consuman operaciones.

## Objetivo

Construir una separación pequeña y explícita:

```text
Graph Kernel
  nodes, edges y snapshots de lectura
  validación genérica del grafo
  precondición opcional de revision
  incremento centralizado de revision
  único punto de lock y mutación
  persistencia atómica, logs y snapshots

Providers
  task       → semántica de tasks y lifecycle
  gate       → semántica de gates y decisiones
  knowledge  → semántica de knowledge y scopes
  policy     → autorización transversal

Adapters / host
  comandos CLI existentes
  api.core.run para el contrato nuevo
  dispatch y registry de operaciones
```

El kernel controla **cómo** se lee, ejecuta y guarda cualquier operación. Los
providers aportan **qué significa** esa operación.

Un plugin nuevo debe poder consumir una operación publicada por un provider
built-in, por ejemplo:

```js
await api.core.run({
  op: "task.create",
  input: {
    initiative: "mi-iniciativa",
    title: "Crear tarea",
    body: "...",
    acceptance: "...",
    blocked_by: ["G-1"]
  }
});
```

La operación debe seguir pasando por las garantías del host y del kernel:
validación, identidad, policy, lock, persistencia atómica y log. Los nombres
exactos de input/output pueden cambiar porque no hay plugins viejos que
compatibilizar.

## Regla central del kernel

Toda mutación de estado, sin importar su origen, debe pasar por el kernel:

- comandos CLI;
- `api.core.run`;
- providers built-in;
- operaciones publicadas por plugins nuevos;
- `plugin-data.set`;
- iniciativas, nodes, edges y lifecycle;
- `init`, `restore` y snapshots cuando modifican el estado.

Solo el kernel puede llamar las primitivas de almacenamiento como `updateState`,
`withLock` y `appendWithContext`. Los providers, plugins y adapters no pueden:

- editar `tasks.json`;
- importar o llamar `updateState`;
- tomar locks manualmente;
- escribir logs directamente;
- decidir o modificar `node.revision`;
- ejecutar una segunda mutación pública mientras ya están dentro de una mutación.

Esto no significa que el kernel conozca las reglas de tasks o gates. Significa
que el kernel es la única puerta por la que una intención se convierte en estado
persistido.

## Alcance de la primera etapa

### 1. Graph Kernel

Extraer una frontera única de mutación y primitivas genéricas para:

- leer el snapshot actual bajo el contexto de la operación;
- crear, leer y actualizar nodos;
- crear y consultar edges;
- validar IDs, endpoints, self-edges y duplicados;
- aceptar una precondición opcional de revisión;
- comparar la revisión esperada dentro del lock;
- aumentar `node.revision` exactamente una vez por cada nodo existente que cambie;
- ejecutar cada mutación bajo el lock de proyecto;
- aplicar la autorización de policy en el punto controlado por el kernel;
- preservar la escritura atómica, el log y snapshots existentes;
- conservar los campos core que el estado v2 actual ya preserva al serializar.

La frontera puede exponerse internamente mediante una primitiva equivalente a
`kernel.mutate(...)`. No es una transacción pública de varias operaciones ni un
segundo mecanismo de persistencia: representa una única mutación lógica y
centraliza su ejecución.

El kernel recibe una operación ya resuelta por el registry y un provider. No
interpreta flags de CLI ni nombres de dominio como `blocked_by` o `task.create`.

El seam interno queda fijado así:

```js
provider.prepare({ snapshot, input, request })
  // read-only → plan inmutable

provider.apply({ tx, plan })
  // → { result, effects }
```

El flujo único es:

```text
policyProvider.applies(request metadata) fuera del lock
  → kernel.mutate({ request, selectedPolicy, provider })
  → toma el lock
  → lee el snapshot actual
  → provider.prepare una sola vez
  → kernel valida if_revision contra el plan
  → selectedPolicy.authorize(snapshot, plan.target, plan.policyAction)
  → provider.apply({ tx, plan }) sobre un draft controlado
  → kernel valida el grafo final
  → calcula cambios y revisions
  → persiste estado + log
  → devuelve result + effects
```

`prepare` no persiste ni muta y recibe el snapshot protegido por el lock. El
plan contiene los nodos existentes afectados, el target para policy, la acción
de autorización y la intención de auditoría. `apply` es la única fase que usa
`tx`; no existe un segundo `prepare` ni un `tx.commit()` público. Los efectos
como `newly_ready` son datos de resultado no persistidos: el provider puede
calcularlos comparando el snapshot con `tx.view()` y el kernel los devuelve al
adapter.

La validación estructural pertenece al kernel. Las restricciones de dominio
(como qué tipos pueden bloquearse o cómo se satisface un blocker) pertenecen a
providers o reglas de relación registradas. El provider valida su dominio en
`prepare`; el kernel valida el plan final antes de escribir.

### 2. Providers built-in

Los providers built-in serán módulos con semántica de dominio y contexto de
kernel controlado. No serán wrappers que mantengan handlers mutantes con sus
propios `withLock`/`updateState`/`appendWithContext`.

Dado que no hay plugins externos viejos que preservar, la migración puede extraer
o reescribir la implementación, pero debe conservar la semántica core definida
para esta fase. No se permiten dos rutas de persistencia.

El contrato conceptual es:

```js
const operation = registry.resolve("task.create");
const selectedPolicy = await policyProvider.select(requestMetadata);

return kernel.mutate({
  request: { operationId: operation.id, actor, pluginId, input },
  selectedPolicy,
  provider: operation.provider,
});
```

El provider expone `prepare({ snapshot, input, request })` y
`apply({ tx, plan })`. El `tx` controlado ofrece solamente
`getNode`, `createNode`, `updateNode`, `addEdge`, `removeEdge` y `view`.
`createNode` no acepta `revision`; el kernel la asigna. Cualquier intento del
provider de escribir `revision`, persistir, tomar un lock o invocar una
mutación pública anidada es inválido.

El provider devuelve `{ result, effects }`. El kernel añade la auditoría,
`plugin_id`, timestamp, incrementos de revisión y persistencia; nunca recibe
una orden de log ya serializada desde el provider.

#### Task provider

Responsabilidades:

- creación y actualización semántica de tasks;
- claim, release, resolve, reopen y cancel;
- backlog;
- derivación `ready|blocked` de tasks;
- satisfacción por `done`/`archived`;
- interpretación de `blocked_by` y construcción de relaciones `BLOCKS`;
- exigir una revisión esperada en las operaciones agent-facing que modifiquen
  una task existente.

#### Gate provider

Responsabilidades:

- creación, resolución, reapertura y cancelación;
- `purpose` y resolution mode;
- supersedencia;
- satisfacción de gates resueltas o supersedidas válidamente;
- exigir una revisión esperada en las operaciones agent-facing que modifiquen
  una gate existente.

#### Knowledge provider

Responsabilidades:

- creación y actualización de knowledge;
- scopes;
- búsqueda y deprecación;
- relaciones informativas y proyecciones específicas;
- exigir una revisión esperada en updates agent-facing de knowledge existente.

#### Policy provider

Responsabilidades:

- discovery/selección de la policy aplicable;
- `applies` y `authorize`;
- decisión de autorización para la operación actual.

No es un tipo de nodo ni persiste datos de dominio por esta propuesta.

## Interfaz agent-facing y `revision`

Una operación agent-facing que modifica un nodo existente debe enviar la revisión
que el agente observó. La interfaz CLI conserva `update` y sus flags de patch
actuales; `--if-revision` es la única precondición. No se agrega ni se usa una
interfaz `before/after`.

```bash
climier update T1 \
  --title "Título nuevo" \
  --if-revision 4 \
  --as agent-1
```

La API nueva usa un input tipado con `changes` e `if_revision`; el adapter CLI
convierte sus flags actuales a esa forma:

```js
await api.core.run({
  op: "task.update",
  input: {
    id: "T1",
    changes: { title: "Título nuevo" },
    if_revision: 4
  }
});
```

La lista de operaciones agent-facing que requieren revisión incluye las que
modifican nodos existentes:

```text
task.update / gate.update / knowledge.update
task.take / task.resolve / task.release / task.reopen / task.cancel
gate.resolve / gate.reopen / gate.cancel
de knowledge.deprecate
note.add cuando modifica el nodo
supersede cuando modifica el nodo reemplazado
```

Las operaciones de creación no tienen una revisión anterior: el nodo nuevo
comienza en `revision: 1`. Las operaciones internas confiables, como restore,
migración o mantenimiento del kernel, pueden omitir la precondición si su contrato
lo permite. Toda operación agent-facing que pueda modificar un nodo existente la
exige, incluso si una ejecución concreta termina siendo idempotente.

La comparación se realiza bajo lock:

```text
agente observa revision 4
  → envía if_revision=4
  → kernel toma lock y lee revision actual
  → si sigue en 4, aplica el cambio
  → si es 5, devuelve REVISION_CONFLICT y no escribe
```

El error conserva `expected` y `current` en sus detalles. Un conflicto no genera
log de mutación exitosa.

## Reglas de incremento de `revision`

`version: 2` es la versión del formato completo del estado. `node.revision` es
un contador persistido por nodo. Son conceptos distintos.

Reglas del kernel:

- nodo nuevo: `revision: 1`;
- update exitoso de un nodo existente: `revision + 1`;
- lifecycle exitoso que cambia un nodo: `revision + 1`;
- una operación que modifica varios nodos incrementa cada nodo modificado una
  sola vez;
- operación idempotente sin cambio: no incrementa ni genera log de mutación;
- `add-edge` que solo agrega una relación no modifica la revisión de nodos que no
  cambian;
- `task.create` con `blocked_by` deja la task nueva en revisión 1 y no incrementa
  las revisiones de sus blockers;
- `add-node --supersedes` deja el nodo nuevo en revisión 1 e incrementa una vez
  el nodo superseded si cambia su estado;
- `note.add` es una mutación del nodo y sigue estas mismas reglas;
- ningún provider modifica directamente la revisión.

La lógica que hoy incrementa revision en distintos handlers debe migrar al kernel
sin cambiar estas reglas observables. El kernel determina los nodos modificados
comparando el snapshot con el draft final; no depende de que el provider recuerde
invocar un `bumpRevision`.

`--if-revision` queda como la forma CLI canónica durante esta fase. La forma
equivalente de la API nueva usa `if_revision`; una operación que modifique más de
un nodo existente usa `if_revisions: { id: revision }` para todos sus targets.
`add-node --supersedes` exige la revisión del nodo reemplazado. Las operaciones
internas explícitamente confiables pueden omitir la precondición.

## Creación de tasks con `blocked_by`

`blocked_by` es una entrada de dominio del task provider, no una regla que el
kernel deba inferir desde un flag.

La ruta CLI es:

```text
climier add-task T2 --blocked-by T1,T3
        ↓
CLI adapter convierte el flag a input tipado
        ↓
task provider valida T1 y T3 contra el snapshot controlado
        ↓
provider prepara T2 + edges BLOCKS
        ↓
kernel valida el plan genérico y lo persiste de una vez
```

El resultado conceptual es:

```text
T1 ──BLOCKS──> T2
T3 ──BLOCKS──> T2
```

El task provider debe verificar, antes de preparar el commit, que cada blocker:

- existe en el snapshot actual;
- es una relación válida para una task;
- no genera un self-edge u otra relación de dominio inválida.

Si alguno falta, la operación falla con un error estructurado —por
compatibilidad con la semántica core actual, `INVALID_EDGE_TARGET` cuando falta
el nodo— y la task no se persiste.

La creación debe prepararse en memoria como una única mutación lógica:

```text
1. preparar nodo T2
2. preparar edges T1 → T2 y T3 → T2
3. validar el plan completo
4. guardar nodo y edges juntos
```

No se crea primero la task para llamar después a `edge.add`, ni se hace rollback
borrando una task ya persistida. Si falla la relación, no queda ninguna parte del
plan en el estado.

El kernel no interpreta `--blocked-by` ni decide qué significa un blocker. Sí
puede aplicar una defensa estructural genérica sobre el plan final —por ejemplo,
que todo edge tenga endpoints existentes, no sea self-edge y use un tipo válido—
antes de persistirlo. Esta defensa no reemplaza la validación semántica del task
provider; protege al grafo frente a providers defectuosos y frente a cambios
entre una prevalidación y el commit.

La misma operación puede ser consumida por un plugin nuevo:

```js
await api.core.run({
  op: "task.create",
  input: {
    initiative: "demo",
    title: "T2",
    body: "...",
    acceptance: "...",
    blocked_by: ["T1", "T3"]
  }
});
```

El plugin entrega una intención. No recibe acceso a `tasks.json`, `updateState` o
`withLock`.

## Registry dinámico y plugins nuevos

Reemplazar el registry estático por un registry construido a partir de providers.
No es necesario preservar la forma del registry, entries o adapters usados por
plugins anteriores.

El nuevo registry debe:

- cargar providers built-in desde un bootstrap único;
- resolver operation IDs estables;
- detectar colisiones determinísticamente;
- devolver errores estructurados para operaciones ausentes;
- entregar al provider un contexto de kernel controlado;
- impedir que un plugin escriba el estado por fuera del kernel;
- mantener `api.core.run({ op, input })` como fachada para el contrato nuevo.

La operación pública no implica que el kernel conozca el dominio. La ruta es:

```text
api.core.run({ op: "task.create", input })
  → registry.resolve("task.create")
  → taskProvider.run(controlledContext)
  → kernel.mutate(...)
  → resultado público
```

Los plugins nuevos pueden consumir `task.create`, `edge.add` y otras operaciones
publicadas según policy y capabilities. Podrán publicar operaciones propias en
una fase posterior, pero no podrán introducir tipos de nodo persistidos en esta
fase.

## Policy como provider transversal

La policy será un provider de autorización aplicado por el kernel a cada
operación mutante. Esto es una reorganización de la autoridad, no una nueva regla
de permisos.

Se conserva el comportamiento core actual:

- `src/policy.mjs` puede seguir siendo la fachada de discovery/adaptación durante
  la migración;
- `applies`/selección ocurre antes del lock y solo depende de metadata de la
  solicitud (`operationId`, actor, plugin y metadata de input), no de un snapshot
  vivo;
- la selección acepta como máximo una policy aplicable y el descriptor elegido
  se congela antes de pasarlo al kernel;
- `authorize` ocurre dentro del lock, contra el snapshot recién leído y el plan
  preparado;
- `prepare` valida dominio antes de autorizar, preservando el orden observable
  actual y errores como `INVALID_EDGE_TARGET`;
- si la policy niega, no hay mutación ni log de éxito;
- se conservan `POLICY_DENIED` y sus detalles.

El kernel no importa ni re-selecciona policies. El policy provider/host hace la
selección fuera del lock; el kernel invoca el descriptor seleccionado dentro del
lock:

```text
policyProvider.applies(request metadata)
  → lock
  → read snapshot
  → provider.prepare(snapshot, input)
  → validate if_revision
  → policy.authorize(snapshot, plan.target, plan.policyAction)
  → provider.apply(tx)
  → generic validation
  → state + revision + log
```

La clasificación de dominio también pertenece al provider. Por ejemplo,
`prepare` devuelve `policyAction: "task.take"` o `"task.takeover"` según el
snapshot; el kernel no la deduce. El plan separa `policyAction` de `logAction`:
los logs core conservan `take`, `resolve`, `update`, etc., mientras policy recibe
la acción detallada.

La policy no define nodos ni lifecycle. Es un rol diferente dentro del sistema
de providers, aunque use el mismo mecanismo de registro.

Un provider no debe llamar otra operación mutante mediante `api.core.run`
mientras ya está dentro de una mutación. Para composición debe usar `tx` o una
intención tipada, evitando locks anidados.

## Mapa de módulos y consumidores

El refactor debe conservar los puntos de entrada core que sigan siendo necesarios
para el CLI y la UI, pero puede cambiar los módulos internos de plugins:

```text
src/kernel/*                  implementación canónica del kernel
src/providers/task/*          provider task
src/providers/gate/*          provider gate
src/providers/knowledge/*     provider knowledge
src/providers/policy/*        provider policy/fachada de src/policy.mjs
src/commands/*                adapters CLI, incluido update con revision
src/v2.mjs                    fachada/re-exports core durante esta fase
src/plugin-core-registry.mjs  bootstrap/registry del contrato nuevo
src/plugin-core-adapter.mjs   adapter de api.core.run nuevo
bin/climier.mjs               dispatch CLI
```

Mapa funcional inicial, que el ADR debe respetar:

```text
src/kernel/mutate.mjs:
  kernel.mutate, transaction draft, preconditions, revision y commit único
src/kernel/edges.mjs:
  EDGE_TYPES, existingEdge, blocksEdge, validateEdge
src/kernel/graph.mjs:
  traversals y consultas genéricas de adyacencia

src/providers/task/:
  lifecycle, satisfacción, derive/status y blocked_by
src/providers/gate/:
  supersededBy, isCurrent, resolución y satisfacción de gates
src/providers/knowledge/:
  matchesScopes, knowledgeForNode y relaciones informativas

src/commands/status.mjs y context.mjs:
  adapters que combinan kernel y providers
src/v2.mjs:
  solo re-exports hacia esos destinos; no contiene una segunda implementación
```

`blockingForNode` e `informingForNode` se implementan como proyecciones de
provider sobre traversals genéricos del kernel. Los consumidores actuales,
incluido `ui/server/server.mjs`, conservan sus imports durante la transición a
través de los re-exports de `v2.mjs`.

La separación concreta de cada función debe quedar en el ADR/plan, pero no se
permiten dos implementaciones canónicas. Los consumidores actuales incluyen
`status.mjs`, `context.mjs`, `take.mjs`, `resolve.mjs`, `add-node.mjs`,
`add-edge.mjs`, `update.mjs` y `ui/server/server.mjs`.

## Compatibilidad y límites

### Se conserva

- `version: 2` del estado core durante esta fase;
- forma core de `nodes`, `edges`, `initiatives` y `log`;
- semántica de `BLOCKS`, incluyendo `blocked_by` y ausencia de task si falta un
  blocker;
- `node.revision` y su incremento por mutación de nodos;
- locks, persistencia atómica, logs y snapshots del kernel;
- nombres de comandos core mientras no exista una razón explícita para cambiarlos;
- `api.core.run({ op, input })` como nombre de fachada del contrato nuevo.

### No se garantiza

- compatibilidad con plugins externos anteriores;
- compatibilidad con el shape anterior de `CORE_REGISTRY`;
- compatibilidad de inputs/outputs antiguos de `api.core.run`;
- compatibilidad con handlers de plugins que escribieran estado directamente;
- compatibilidad con contratos de plugin data no definidos por el nuevo ADR;
- compatibilidad futura si una release posterior elimina `node.revision`;
- compatibilidad con nuevos tipos de nodo persistidos.

Los operation IDs pueden ser nuevos o cambiar de implementación. El contrato
agent-facing nuevo usa revisión esperada; no se mantiene una segunda interfaz
`before/after`.

## Control plane durante la refactorización

El CLI global puede estar linkeado al worktree principal. Eso significa que un
cambio incompleto en `main` puede romper el comando que coordina la propia
refactorización.

La solución operativa es mantener un checkout/binario de control separado y
fijado a un commit estable:

```text
climier-control/       versión estable; no se modifica
climier/               worktree principal en refactorización
climier-worktrees/     branches de workers
```

Puede ser un worktree detached hermano o un clone separado:

```bash
git worktree add --detach ../climier-control <stable-commit>
```

El control plane se usa para `status`, `context`, `take`, `add-note`, `resolve`,
`release` y demás operaciones del DAG. Los workers y scripts deben resolver ese
binario estable mediante un wrapper/PATH controlado o un `CLIMIER_BIN` explícito.

Las operaciones del control plane son una superficie confiable y pueden usar el
contexto interno que corresponda; las operaciones agent-facing del CLI nuevo
deben incluir `--if-revision` cuando modifican nodos existentes.

El código nuevo se prueba desde el worktree de la task con su propio:

```bash
node bin/climier.mjs ...
```

Las mutaciones de smoke usan `bash .agents/skills/climier/smoke-sandbox.sh -- ...`.
El estado de coordinación sigue siendo compartido mediante el mismo
`CLIMIER_HOME` y el mismo `.climier.json`; se separa el código del CLI, no la
pizarra de trabajo.

## Fuera de alcance

- nuevos tipos de nodo persistidos creados por plugins;
- schema v3 o migración inmediata de `node.revision`;
- eliminación de `node.revision` en esta release;
- compatibilidad con plugins externos anteriores;
- resolución de dependencias, versiones o instalación transitiva de plugins;
- transacciones públicas multi-operación, batches o rollback;
- hooks, eventos, scheduler, workers o ejecución autónoma;
- UI genérica o formularios para providers arbitrarios;
- sandbox, firmas, autenticación o permisos nuevos;
- invocación de comandos CLI de otro plugin mediante argv.

## Plan incremental y dependencias

### Bootstrap previo

Antes de crear tasks de implementación se requiere un bootstrap task con un plan
en `docs/plans/<id>-execution.md` que fije paths exclusivos, batches,
dependencias, acceptance y no-go zones.

### Orden recomendado

```text
1. contrato del kernel, tx, precondición opcional y revision activa
       ↓
2. extracción del kernel y adapters, con v2.mjs como re-export
       ↓
3. migración de handlers mutantes a la única frontera del kernel
       ↓
4. providers task/gate/knowledge usando el contexto controlado
       ↓
5. policy provider con authorize bajo lock
       ↓
6. registry nuevo y adapter api.core.run sin compatibilidad legacy
       ↓
7. adapters CLI/API, incluido if_revision obligatorio en updates agent-facing
       ↓
8. paridad core, concurrencia, snapshots, blocked_by y UI
```

El bootstrap fija una dependencia dura y no solo una recomendación:

```text
§1 contrato kernel/tx/revision (serial)
  → §2 extracción kernel + fachada v2 (serial)
  → §3 migración de handlers a adapters (serial por handler)
  → §4 providers task/gate/knowledge (paralelo, paths separados)
  → §5 policy provider (después del seam de §1)
  → §6A buildRegistry(providers) (sin tocar dispatch)
  → §6B adapter api.core.run
  → §7 dispatch CLI y adapters de comandos
  → §8 integración, concurrencia, snapshots y UI
```

Ninguna task de §3/§4 puede arrancar hasta que §1 cierre y el bootstrap publique
la firma de `tx`. `state.mjs`, `lock.mjs`, `log.mjs`, `v2.mjs`,
`plugin-core-registry.mjs`, `plugin-core-adapter.mjs` y `bin/climier.mjs`
requieren ownership serializado o explícitamente no solapado. El máximo
operativo recomendado es tres workers simultáneos.

El registry se reemplaza sin compatibilidad con el anterior, pero en dos slices:

```text
A. buildRegistry(providers) devuelve entries construidas; no toca dispatch
B. adapter api.core.run consume el builder y luego se migra el dispatch CLI
```

`update.mjs` entra en esta migración porque es una ruta de escritura y debe exigir
`--if-revision` en la superficie agent-facing. Los lifecycle handlers también
pasan por el kernel y aplican la regla de incremento una sola vez.

## Tests requeridos

### Baseline core

Se reutiliza la suite existente como baseline para la semántica core; no se crean
tests para compatibilidad con plugins que no existen. Cada slice debe declarar
y ejecutar sus tests focalizados, además del baseline que corresponda:

| Slice | Tests mínimos |
|---|---|
| kernel/tx/revision | `node --test test/v2-update.test.mjs test/v2-blocked-by.test.mjs test/state-snapshots.test.mjs` |
| task/lifecycle | `node --test test/v2-take.test.mjs test/v2-update.test.mjs test/v2-blocked-by.test.mjs` |
| policy | `node --test test/plugin-policy-parity-cli-api.test.mjs test/plugin-policy-concurrency.test.mjs` |
| registry/adapter | `node --test test/plugin-core-registry.test.mjs test/plugin-dispatch.test.mjs test/cli-dispatch.test.mjs test/unknown-flags.test.mjs` |
| concurrencia/snapshots | `npm run test:concurrent && node --test test/state-snapshots.test.mjs test/snapshots-restore.test.mjs` |
| consumidor UI directo | `npm run test:ui` |

El baseline completo (`npm test`, más `npm run test:concurrent` cuando el slice
toque locks/estado) se exige antes de integrar.

Se agregan únicamente tests de contrato para las nuevas fronteras.

### Kernel y revision

- creación/actualización genérica de nodos;
- operación agent-facing sin `if_revision`: rechazo estructurado;
- revisión coincidente: commit exitoso;
- revisión obsoleta: `REVISION_CONFLICT` y ningún campo escrito;
- varios campos en una operación: comparación y commit all-or-nothing;
- cada nodo modificado incrementa revision exactamente una vez;
- operaciones que modifican varios nodos incrementan cada uno una sola vez;
- operación idempotente no incrementa ni genera log de mutación;
- operación interna permitida sin precondición;
- `revision` nunca es modificado por providers;
- lock y escritura atómica;
- provider/plugin sin import ni acceso a `tasks.json`, `updateState` o `withLock`;
- mutación anidada rechazada o controlada sin doble lock;
- logs coherentes con cada mutación exitosa.

### `blocked_by`

- task con un blocker existente;
- task con múltiples blockers CSV o input tipado;
- blocker inexistente: error estructurado y ningún nodo nuevo persistido;
- blocker de tipo inválido;
- self-edge;
- fallo en cualquier edge: no quedan task ni edges parciales;
- task nueva con `revision: 1` y blockers existentes sin revisión modificada;
- misma semántica para CLI y `api.core.run` nuevo.

### Providers built-in

- vectores actuales de task, gate y knowledge;
- lifecycle y estados derivados;
- satisfacción de `BLOCKS`;
- proyecciones de `status`, `context`, `history` y `show`;
- policy allow/deny/abstain con la misma semántica core;
- provider decide reglas de dominio, pero el kernel realiza la persistencia y la
  revisión.

### Registry y plugins nuevos

- bootstrap y resolución de providers;
- colisiones deterministas;
- operación ausente con error estructurado;
- `api.core.run` cumple el contrato nuevo;
- provider fixture que consuma `task.create` y `blocked_by`;
- identidad fijada por host y `plugin_id` preservado en logs nuevos;
- ningún plugin ejecuta argv ni importa `bin/climier.mjs` o `src/commands/*` para
  mutar estado;
- operación anidada sin doble lock ni corrupción;
- no se ejecuta una suite de compatibilidad con plugins antiguos.

### Compatibilidad core, concurrencia y snapshots

- estado v2 antes/después del refactor;
- comandos core con la forma acordada para esta release;
- `test/plugin-policy-parity-cli-api.test.mjs` adaptado al contrato nuevo si
  sigue cubriendo operaciones core;
- `test/plugin-log-seam.test.mjs` adaptado al host nuevo;
- `test/plugin-core-concurrency.test.mjs`;
- `test/plugin-policy-concurrency.test.mjs`;
- `test/v2-adversarial.test.mjs`;
- `test/state-snapshots.test.mjs`;
- `test/snapshots-restore.test.mjs`;
- snapshots v2 creados con CLI estable y restaurados por el CLI nuevo;
- `npm run test:ui` en cada PR que modifique `src/v2.mjs`, sus exports o
  `ui/server/server.mjs`.

La paridad de estado debe usar fixtures deterministas y comparar la estructura
core completa, normalizando únicamente valores dinámicos explícitos como
timestamps. El test de paridad no debe convertir la compatibilidad con plugins
inexistentes en requisito.

## Soluciones incorporadas a los hallazgos de reviewers

- **Provider vs kernel:** provider aporta semántica; kernel ejecuta y persiste.
- **Seam:** `prepare` read-only produce un plan; `apply` usa el único `tx` controlado.
- **Única mutación:** todo entra por `kernel.mutate`; ningún provider escribe el
  estado directamente.
- **Precondición:** `if_revision`/`if_revisions` es obligatorio en mutaciones
  agent-facing de nodos existentes; no existe `before/after`.
- **Revision:** permanece activa en v2; el kernel calcula el diff y es dueño del
  incremento exacto, incluyendo `note.add`.
- **Validación/policy:** `prepare` valida dominio antes de `authorize`; la policy
  se selecciona fuera del lock y autoriza dentro del lock.
- **Acciones:** el provider clasifica `policyAction`; el kernel no deduce dominio;
  los logs conservan los `logAction` core actuales.
- **Efectos:** `newly_ready` y similares vuelven como resultado no persistido.
- **`v2.mjs`:** queda como fachada/re-export core durante esta fase, sin doble
  implementación.
- **Providers built-in:** se extrae o reescribe la semántica sin conservar
  handlers mutantes paralelos.
- **Registry:** se construye desde providers en dos slices, sin compatibilidad con
  plugins viejos.
- **`blocked_by`:** provider valida antes del commit; kernel guarda task + edges
  juntos y no persiste tareas parciales.
- **CLI/control plane:** binario estable separado, mismo `CLIMIER_HOME`, smoke
  objetivo antes de delegar y máximo tres workers simultáneos.
- **Tests:** cada slice declara tests focalizados; UI se exige cuando se modifica
  su consumidor directo, no por un re-export puro.
- **Slicing:** bootstrap task obligatorio y ownership no solapado para archivos
  centrales.

## Decisiones que documentarán los ADRs derivados

El RFC ya fija la dirección; los ADRs solo formalizarán y harán ejecutable el
contrato decidido:

1. ADR-011: firma de `kernel.mutate`, plan, `tx`, policy, efectos y revision.
2. ADR-012: providers, registry dinámico, `api.core.run`, adapters y control
   plane.
3. La preservación de campos v2 y la migración futura de `node.revision` quedan
   como límites explícitos, no como decisiones abiertas de implementación.

## Impacto sobre ADRs existentes

- ADR-004 continúa como referencia para smoke, snapshots, restore y preservación
  del estado v2.
- ADR-005 continúa como referencia histórica del host, pero su contrato de
  plugins puede ser reemplazado porque no hay plugins antiguos que preservar.
- ADR-006 debe revisarse porque fija una registry y un input contract anteriores;
  `api.core.run` se conserva como nombre, no como compatibility promise.
- ADR-007 aporta el contrato histórico de policy; el nuevo provider debe conservar
  la semántica acordada que siga siendo necesaria.
- ADR-008 debe ser superseded en la parte del seam por handler si el kernel pasa a
  coordinar la mutación y autorización.
- ADR-009 conserva las reglas de identidad/autoridad que sigan aplicando; el nuevo
  ADR debe declarar cómo conviven con el kernel.

Los ADRs aprobados no se reescriben silenciosamente. Se crean ADRs nuevos con
`--supersedes` cuando reemplazan una decisión anterior; los ADRs propuestos que
queden obsoletos se marcan como superseded o se reemplazan según el DAG.

No se crean tasks de implementación hasta aprobar el ADR derivado y el bootstrap
plan.

## Tamaño estimado

- Contrato y extracción compatible del kernel: mediano/grande.
- Migración de los cuatro providers: grande.
- Registry nuevo y adapters: mediano/grande.
- Interfaz agent-facing con `if_revision`: mediano.
- Tests de paridad, concurrencia y snapshots: mediano.

El trabajo total es grande y debe dividirse por ownership de módulos. La primera
entrega conserva el estado core v2 y `node.revision`, pero no promete compatibilidad
con plugins externos anteriores ni introduce `before/after`.
