# Plan de ejecución: Graph Kernel y providers internos

Este documento es el único entregable de `T-graph-kernel-providers-bootstrap`.
No implementa producto ni crea tasks hijas. Deriva de:

- RFC aprobado: `.decisions/G-graph-kernel-providers-rfc.md`;
- ADR-011 aprobado: `.adrs/011-graph-kernel-providers.md`;
- ADR-012 aprobado: `.adrs/012-graph-kernel-registry-api.md`.

## 1. Control plane y preflight

La coordinación usa exclusivamente el Climier global estable:

```bash
command -v climier
# /home/yeferson/.npm-global/bin/climier
readlink -f "$(command -v climier)"
# /home/yeferson/Dev/climier-control/bin/climier.mjs
```

El commit estable observado para el control plane es:

```text
e8e9a5f03c85a39708bf172227a5ce91e1e9abae
```

El wrapper de coordinación debe resolver siempre `climier` global. Nunca debe
invocar `node bin/climier.mjs` para `status`, `context`, `take`, `update`,
`add-note`, `resolve`, `release` u otra operación del DAG.

Antes de delegar la primera task, verificar el binario estable en un sandbox
privado, sin tocar el `CLIMIER_HOME` real:

```bash
bash .agents/skills/climier/smoke-sandbox.sh -- \
  /home/yeferson/Dev/climier-control/bin/climier.mjs --help
```

El código del refactor se verifica desde cada worktree con su propio
`node bin/climier.mjs ...`; ese uso no coordina el DAG.

## 2. Reglas de ownership

Ownership serializado, nunca en paralelo:

```text
src/state.mjs
src/lock.mjs
src/log.mjs
src/kernel/mutate.mjs
src/kernel/transaction.mjs
src/v2.mjs
src/plugin-core-registry.mjs
src/plugin-core-adapter.mjs
bin/climier.mjs
```

Los providers pueden trabajar en paralelo solo cuando el contrato de ADR-011
esté integrado y sus paths no se superpongan. Máximo operativo: tres workers.
Cada worker toma una sola task; el validator debe auditar y mergear antes de
considerar satisfecha una dependencia.

No se permiten:

- dos implementaciones canónicas de una función;
- handlers que conserven `withLock`, `updateState` o `appendWithContext` propios;
- escritura manual del estado o del DAG;
- modificación de `node.revision` desde providers;
- edición del checkout `climier-control` durante el refactor;
- uso del binario local del worktree como control plane.

## 3. Dependencias y batches

```text
B0 preflight del control plane
  ↓
B1 contrato kernel/tx/revision (serial)
  ↓
B2 extracción de primitivas y fachada v2 (serial)
  ↓
B4 providers task + gate + knowledge (hasta 3 en paralelo)
  ├──────────────→ B5 policy provider y seam de autorización
  ↓
B6A buildRegistry(providers) (serial; no toca dispatch)
  ↓
B3 migración de adapters mutantes (serial por ola)
  ↓
B6B api.core.run adapter (serial)
  ↓
B7 dispatch CLI y adapters de flags (serial)
  ↓
B8 integración core + consumidores UI + auditoría final
```

B1 debe terminar antes de materializar B2/B4. B4 solo puede paralelizarse por
provider y después de B2, con máximo tres workers. B5 puede comenzar cuando B2
esté validado y no comparte paths con B4. B6A depende de los providers; no
puede tocar `plugin-core-adapter.mjs` ni `bin/climier.mjs`. B3 consume el
registry ya construido y los providers/policy validados. B6B es quien consume
el builder desde la API de plugins.

## 4. Slices candidatos

Las siguientes piezas son candidatas a tasks. Este plan no las crea.

### B1 — contrato del kernel, dividido en dos tasks secuenciales

#### B1a — `T-graph-kernel-transaction`

- Paths exclusivos: `src/kernel/transaction.mjs` y
  `test/kernel-transaction.test.mjs`.
- Cambiar: draft puro, `createTransaction(snapshot)`,
  `getNode/createNode/updateNode/addEdge/removeEdge/view`, clonación y
  rechazo de escritura de `revision`.
- Acceptance: task + edges se pueden componer en memoria; se rechazan ids,
  nodos, self-edges y edges duplicados inválidos; no hay filesystem, locks,
  persistencia, logs ni `commit()` público.
- Tests mínimos: `node --test test/kernel-transaction.test.mjs` y
  `npm test` con el runner core acotado.
- No-go: `kernel.mutate`, providers, registry, dispatch y UI.

#### B1b — `T-graph-kernel-contract`

- Dependencia dura: B1a validada y mergeada.
- Paths exclusivos: `src/kernel/mutate.mjs`; puede ajustar
  `src/state.mjs`, `src/lock.mjs`, `src/log.mjs` y tests de integración.
- Cambiar: firma de `kernel.mutate`, prepare/apply, precondiciones,
  autorización, diff de nodos, incremento único de revision, persistencia y
  log bajo un único lock.
- Acceptance: provider fixture con `prepare/apply`; creación, update,
  idempotencia, conflicto, multi-nodo, task + edges, efectos no persistidos y
  mutación anidada cubierta; ningún provider puede modificar revision.
- Tests mínimos: `node --test test/kernel-mutate.test.mjs
  test/v2-update.test.mjs test/v2-blocked-by.test.mjs
  test/state-snapshots.test.mjs` y `npm test`.
- No-go: `src/kernel/transaction.mjs`, providers, registry, dispatch y UI.

### B2 — grafo y fachada

- Paths exclusivos: `src/kernel/edges.mjs`, `src/kernel/graph.mjs`,
  `src/v2.mjs` y tests nuevos de kernel/fachada.
- Cambiar: extraer primitivas genéricas de edges y traversals; `v2.mjs`
  delega o re-exporta sin conservar una segunda implementación canónica.
- Acceptance: `v2.mjs` mantiene los imports públicos actuales; el mapa de
  funciones genéricas del ADR-012 queda verificable; consumers actuales siguen
  resolviendo sus imports; el kernel no contiene semántica de lifecycle,
  providers ni filesystem.
- Tests mínimos: `node --test test/v2-edges.test.mjs
  test/v2-adversarial.test.mjs` y tests nuevos de `kernel/`; `npm run test:ui`
  solo si cambia el consumidor directo `ui/server/server.mjs`.
- No-go: `src/providers/*`, mutadores, registry y `bin/climier.mjs`.

### B3 — adapters de mutadores

Se ejecuta en dos olas seriales para limitar el blast radius y después de
B4+B5+B6A:

1. `add-task`, `add-node`, `add-edge`, `take`, `update`:
   `test/v2-blocked-by.test.mjs`, `test/v2-edges.test.mjs`,
   `test/v2-take.test.mjs`, `test/v2-update.test.mjs`.
2. `add-gate`, `add-knowledge`, `add-initiative`, `deprecate-knowledge`,
   `add-note`, `resolve`, `release`, `reopen`, `cancel`:
   `test/v2-lifecycle.test.mjs`, `test/v2-supersede.test.mjs`,
   `test/plugin-log-seam.test.mjs`.

Cada handler queda como adapter del provider/kernel, sin `withLock`,
`updateState`, `appendWithContext` ni incremento manual. `update` mantiene sus
flags CLI actuales y exige `--if-revision`; `note.add` exige revisión y bump.
No-go: cambiar `plugin-core-adapter.mjs` o `bin/climier.mjs` en estas olas.

### B4 — providers de dominio, divididos por contrato y lifecycle

- Dependencia base: B1+B2. Los slices base de task, gate y knowledge pueden
  paralelizarse entre sí, con máximo tres workers; cada worker toca solo su
  directorio y tests.
- Acceptance común: `prepare` valida dominio, `apply` usa únicamente tx,
  lifecycle y proyecciones conservan semántica, errores estructurados y no hay
  acceso a filesystem.

#### B4-task-core — `T-graph-kernel-provider-task`

`task.create` y `task.update`, incluyendo `blocked_by` atómico, patches y
precondiciones. No implementa lifecycle.

#### B4-task-lifecycle — `T-graph-kernel-provider-task-lifecycle`

Depende de task-core. Añade `task.take`/`task.takeover`, `task.resolve`,
`task.release`, `task.reopen` y `task.cancel`, además de `newly_ready`.

#### B4-gate-core — `T-graph-kernel-provider-gate`

`gate.create` y supersedencia multi-nodo con reescritura de blockers.

#### B4-gate-lifecycle — `T-graph-kernel-provider-gate-lifecycle`

Depende de gate-core. Añade `gate.resolve`, `gate.reopen` y `gate.cancel`.

#### B4-knowledge-core — `T-graph-kernel-provider-knowledge`

`knowledge.create`, `knowledge.update` y helpers puros de scopes, búsqueda,
ranking e informing.

#### B4-knowledge-lifecycle — `T-graph-kernel-provider-knowledge-lifecycle`

Depende de knowledge-core. Añade `knowledge.deprecate` y sus proyecciones.

Cada slice reusa sus tests `v2-*` existentes y añade solo contratos nuevos de
provider/kernel necesarios. B6A espera validación PASS de los seis slices.

### B5 — policy transversal

- Paths: `src/providers/policy/*`, `src/policy.mjs`, tests policy.
- Dependencia: B1+B2; puede ejecutarse después de B2 y en paralelo con la
  implementación de providers B4 si no comparte paths.
- Acceptance: `applies` selecciona descriptor por metadata fuera del lock;
  `authorize` corre dentro del lock con snapshot y plan frescos; errores
  `POLICY_DENIED` y allow/deny/abstain se preservan; no hay doble lock; los
  adapters posteriores reciben solo el descriptor seleccionado.
- Tests mínimos: `node --test test/plugin-policy-parity-cli-api.test.mjs
  test/plugin-policy-concurrency.test.mjs
  test/plugin-policy-seam-dag.test.mjs
  test/plugin-policy-seam-lifecycle.test.mjs
  test/plugin-policy-seam-state-ops.test.mjs`.

### B6A — builder del registry

- Paths: `src/plugin-core-registry.mjs` y su test.
- Dependencia: B1+B2+B4; ownership serial. No inicia hasta que los tres
  providers tengan validación PASS.
- Acceptance: `buildRegistry(providers)` construye entries con `id`, `kind`,
  provider `prepare/apply`; detecta colisiones; no toca adapter ni dispatch;
  no persiste registro y no importa handlers mutantes.
- Tests mínimos: `node --test test/plugin-core-registry.test.mjs`.

### B6B — adapter `api.core.run`

- Paths: `src/plugin-core-adapter.mjs`, errores y tests de adapter.
- Dependencia: B6A+B5; B3 puede ejecutarse antes o en paralelo, pero B7 espera
  ambos.
- Acceptance: resuelve operation IDs, fija actor/pluginId desde host, rechaza
  `as`/`_as`, traduce errores estructurados, ejecuta kernel y preserva
  `plugin_id` en logs; no ejecuta argv ni importa comandos mutantes.
- Tests mínimos: `node --test test/plugin-core-adapter.test.mjs
  test/plugin-dispatch.test.mjs
  test/plugin-core-errors.test.mjs`.

### B7 — dispatch y adapters CLI

- Paths: `bin/climier.mjs`, `src/commands/*` únicamente como adapters y tests
  de dispatch.
- Dependencia: B3+B6B.
- Acceptance: flags actuales, `knownFlags`, boolean flags y `--if-revision`
  conservan el contrato acordado; `api.core.run` y CLI llegan al mismo
  provider; `node bin/climier.mjs` solo se usa como verificación del worktree.
- Tests mínimos: `node --test test/cli-dispatch.test.mjs
  test/unknown-flags.test.mjs test/plugin-dispatch.test.mjs`.

### B8 — integración, dividido en core, UI y auditoría

#### B8-core — integración core, concurrencia y snapshots

- Paths exclusivos: tests de integración, concurrencia y snapshots; solo una
  fixture estrictamente necesaria.
- Dependencia: B7 y, transitivamente, B4+B5+B6B.
- Acceptance: no corrupción bajo concurrencia, snapshots v2 compatibles,
  `newly_ready`, revisiones, logs y paridad CLI/API correctos.
- Tests: `npm test`, `npm run test:concurrent` y
  `node --test test/state-snapshots.test.mjs test/snapshots-restore.test.mjs`.

#### B8-ui — consumidores UI

- Paths exclusivos: `ui/server/*` y tests UI solo si el contrato directo lo
  requiere.
- Dependencia: B7; no modifica kernel ni providers.
- Acceptance: consumidores de `v2.mjs` funcionando, sin mutar estado ni
  duplicar semántica.
- Tests: `npm run test:ui` y `(cd ui && npm run build)` cuando corresponda.

#### B8-final — `T-graph-kernel-integration`

- Dependencia: B8-core+B8-ui.
- Solo audita evidence, diffs, tests y contratos mergeados; no implementa
  producto. Si encuentra una regresión, abre una corrección separada.
- Acceptance: árbol limpio, una única ruta de mutación y compatibilidad final
  de CLI/API/UI confirmada con una nota de cierre concreta.

## 5. Criterio de integración

Antes de integrar cualquier slice:

1. el worker deja nota y resuelve su task mediante el Climier global;
2. un `climier-validator` independiente devuelve `PASS` y deja
   `VALIDATION PASS ... merged=true`;
3. se ejecutan los tests mínimos del slice y el baseline proporcional;
4. el árbol queda ejecutable y sin cambios no relacionados;
5. el control plane sigue apuntando al checkout estable y al mismo
   `CLIMIER_HOME`.

El bootstrap se considera completo cuando estas piezas están publicadas como
tasks con paths exclusivos, dependencias reales, acceptance verificable y
ningún worker puede comenzar B3/B4 sin que B1 esté resuelta y validada.

## 6. Sello de validación del bootstrap

Esta sección la agrega `T-graph-kernel-providers-bootstrap` al cierre y no
forma parte del plan operativo. Registra la verificación proporcional
realizada por el worker para confirmar que el documento cumple la acceptance
antes de delegar las tasks derivadas.

- Acceptance cubierta:
  - `docs/plans/G-graph-kernel-providers-execution.md` existe y fue revisado
    contra `.decisions/G-graph-kernel-providers-rfc.md`,
    `.adrs/011-graph-kernel-providers.md` y
    `.adrs/012-graph-kernel-registry-api.md`;
  - la sección 2 enumera ownership serializado para `src/state.mjs`,
    `src/lock.mjs`, `src/log.mjs`, `src/kernel/mutate.mjs`,
    `src/kernel/transaction.mjs`, `src/v2.mjs`,
    `src/plugin-core-registry.mjs`, `src/plugin-core-adapter.mjs` y
    `bin/climier.mjs`, sin solapamiento;
  - la sección 3 fija la dependencia dura
    `B1 kernel → B4 providers → B6A registry → B6B/B7 adapters`;
  - la sección 2 y los no-go de cada batch limitan a tres workers
    simultáneos como máximo;
  - cada batch B1–B8 declara `Tests mínimos` focalizados y referencia el
    baseline (`npm test`, `npm run test:concurrent`, `npm run test:ui` cuando
    aplica);
  - la sección 1 fija el smoke del binario global estable
    `climier-control` mediante `smoke-sandbox.sh`, sin tocar
    `CLIMIER_HOME`;
  - el plan no crea tasks ni modifica código de producto: lo afirma en la
    introducción, en `B1`–`B8` con sus no-go zones y en la presente
    validación.
- Verificación proporcional ejecutada por el worker:
  - inspección del diff del commit que introduce el documento;
  - comprobación de que el binario
    `/home/yeferson/Dev/climier-control/bin/climier.mjs` existe y responde
    a `--help` dentro de `smoke-sandbox.sh`;
  - comprobación de que la cadena de batches respeta la dependencia dura
    B1 → B2 → B3 → B4 → B5 → B6A → B6B → B7 → B8.
- Resultado: la acceptance queda cubierta. El plan queda publicado y listo
  para que el orchestrator derive tasks ejecutables siguiendo los slices
  B1–B8 sin que este bootstrap cree ni modifique el DAG.
