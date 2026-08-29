# ADR-012: Providers built-in, registry y API core nueva

- Gate: `G-graph-kernel-registry-adr` · Deriva de: `G-graph-kernel-providers-rfc` · Estado: aprobado
- Fecha: 2026-08-29

## Contexto

El registry actual mezcla entries fijas con handlers que poseen locks y
persistencia. El refactor aprobado separa providers internos de adapters y
conserva `api.core.run({ op, input })` únicamente como nombre de fachada. No
hay plugins externos antiguos que deban mantener el contrato previo.

El kernel/provider seam de ADR-011 es una dependencia dura de este ADR. El
registry no debe crear una segunda ruta de estado ni registrar operaciones
persistentes por fuera del kernel.

## Decision

### 1. Providers y entries

El registry se construye en cada arranque desde un bootstrap explícito de
providers built-in:

```js
{
  id: "task.create",
  provider: taskProvider,
  kind: "task",
}
```

Cada entry resuelve a un provider con `prepare` y `apply`; no conserva un
`handler` mutante que llame `withLock`, `updateState` o `appendWithContext`.
`buildRegistry(providers)` detecta colisiones de operation IDs de forma
determinista y devuelve un registry inmutable para los consumidores.

El primer slice del builder no cambia `bin/climier.mjs` ni el dispatch. El
segundo adapta `plugin-core-adapter.mjs` y luego el dispatch para consumir el
nuevo entry shape. No se preserva `CORE_REGISTRY` ni la forma de entries de
plugins antiguos.

### 2. Operaciones y API

El host conserva la llamada:

```js
await api.core.run({ op, input })
```

El adapter fija `actor`/identidad y `pluginId` desde el host. El input no puede
sustituirlos mediante `as`, `_as` o campos equivalentes. El adapter resuelve
`op`, selecciona la policy por metadata y entrega la operación al kernel.

Los operation IDs nuevos son estables dentro de esta fase, incluyendo como
mínimo:

```text
task.create / task.update / task.take / task.resolve
 task.release / task.reopen / task.cancel
gate.create / gate.resolve / gate.reopen / gate.cancel
knowledge.create / knowledge.update / knowledge.deprecate
note.add / edge.add / initiative.create
```

La API usa inputs tipados. `task.update` recibe `id`, `changes` e `if_revision`;
la CLI conserva sus flags existentes y los adapta a esa forma. No se ejecuta
argv de otros plugins, no se importan comandos CLI para mutar y no se agregan
tipos de nodo persistidos por plugins.

Los resultados del kernel conservan el resultado de dominio y los efectos no
persistidos, por ejemplo `newly_ready`. El adapter puede proyectarlos al shape
CLI existente sin hacer una segunda mutación.

### 3. Providers built-in y fachada v2

La implementación puede extraer o reescribir handlers, pero solo queda una
implementación canónica por responsabilidad. Los destinos funcionales son:

```text
src/kernel/mutate.mjs       lock, snapshot, tx, diff, revision, commit
src/kernel/transaction.mjs  draft tipado y vista de lectura
src/kernel/edges.mjs        EDGE_TYPES, endpoints y validación estructural
src/kernel/graph.mjs        traversals genéricos
src/providers/task/*        lifecycle, derive/status y blocked_by
src/providers/gate/*        resolución y supersedencia
src/providers/knowledge/*   scopes, búsqueda y relaciones informativas
src/providers/policy/*      selection/adaptación y autorización
```

`src/v2.mjs` solo re-exporta las funciones que todavía consumen
`status.mjs`, `context.mjs`, lifecycle y `ui/server/server.mjs`. Un re-export
puro no dispara por sí mismo la suite UI; `npm run test:ui` es obligatorio cuando
se modifica el consumidor UI directo o el contrato que éste usa.

`blockingForNode` e `informingForNode` combinan traversals del kernel con
proyecciones tipadas de providers, sin volver a introducir lógica canónica en
`v2.mjs`.

### 4. Policy y logs

El adapter/host ejecuta `policyProvider.applies` antes del lock usando metadata
de request. El descriptor seleccionado se congela y el kernel ejecuta
`authorize` dentro del lock con el snapshot y plan frescos.

El provider devuelve intención de auditoría sin timestamp ni identidad. El
kernel crea el log y agrega `plugin_id` desde el descriptor del host. Los logs
core mantienen sus `action` actuales (`add-task`, `take`, `resolve`, etc.); el
`policyAction` detallado (`task.take`, `task.takeover`) queda para policy y no
reemplaza el campo de auditoría existente.

### 5. Ciclo de vida del registry

El registry de providers built-in es configuración de proceso, no estado del
proyecto. Se reconstruye al arrancar desde código versionado. No existe un
comando `plugin register` ni un archivo de operaciones registradas en esta
fase; por tanto, no hay mutación fuera de `kernel.mutate`.

La publicación de operaciones propias de plugins queda fuera de alcance. Una
fase posterior podrá definir un bootstrap explícito, pero no podrá introducir
tipos persistidos ni escribir el estado sin pasar por el kernel.

### 6. Control plane

La coordinación Climier usa exclusivamente el binario global estable de
`climier-control`, verificado con `command -v climier` y un smoke sobre fixture
fresca. Nunca se usa `node bin/climier.mjs` para `status`, `context`, `take`,
`update`, `add-note`, `resolve` ni otra mutación del DAG.

El CLI del worktree se ejecuta solo para verificar el código que se desarrolla.
El control plane y los worktrees comparten `CLIMIER_HOME` y `.climier.json`, pero
el control plane vive en un checkout/commit estable separado del refactor.

## Consecuencias

- A favor:
  - registry determinista y fácil de inspeccionar;
  - providers internos y plugins nuevos consumen el mismo contrato;
  - ninguna operación del adapter puede saltarse el kernel;
  - la identidad del host y `plugin_id` quedan fuera del input no confiable;
  - la fachada v2 permite migrar consumidores por etapas.
- En contra / deuda:
  - no existe compatibilidad con el registry ni API de plugins anteriores;
  - el builder, adapter y dispatch requieren una transición coordinada;
  - la publicación de operaciones externas queda para otra fase;
  - el control plane requiere conservar un checkout estable separado.

## Plan de implementación

1. **Contrato de entries** — `src/plugin-core-registry.mjs` añade
   `buildRegistry(providers)` sin tocar dispatch.
2. **Bootstrap built-in** — providers task/gate/knowledge/policy publican sus
   operation IDs después de ADR-011.
3. **Adapter core** — `src/plugin-core-adapter.mjs` resuelve entries nuevas,
   fija identidad y traduce errores.
4. **Dispatch y adapters CLI** — `bin/climier.mjs`, `src/commands/*` y
   `update`/lifecycle consumen el kernel sin mutaciones propias.
5. **Consumers** — `v2.mjs`, status/context y UI server conservan re-exports y
   se validan por consumidor directo.
6. **Integración** — logs, policy, concurrencia, snapshots y fixtures de
   `api.core.run` según el bootstrap plan.

## Verificación

- Registry con providers built-in, colisiones y operation IDs ausentes.
- `api.core.run` con identidad fijada por host y `plugin_id` en logs.
- Paridad CLI/API de `task.create`, `task.update`, lifecycle y `blocked_by`.
- Prohibición de `as`/`_as`, argv y acceso directo a `tasks.json`.
- `test/plugin-core-registry.test.mjs`, `test/plugin-core-adapter.test.mjs`,
  `test/plugin-dispatch.test.mjs`, `test/cli-dispatch.test.mjs` y
  `test/unknown-flags.test.mjs`.
- `test/plugin-policy-parity-cli-api.test.mjs` y
  `test/plugin-policy-concurrency.test.mjs` adaptados al seam nuevo.
- Smoke del control plane global con el mismo `CLIMIER_HOME`.
- `npm test`, `npm run test:concurrent`, `npm run test:ui` cuando corresponda
  y `git diff --check`.
