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
B3 migración de adapters mutantes (serial por ola)
  ↓
B4 providers task + gate + knowledge (hasta 3 en paralelo)
  ↓
B5 policy provider y seam de autorización
  ↓
B6A buildRegistry(providers) (serial; no toca dispatch)
  ↓
B6B api.core.run adapter (serial)
  ↓
B7 dispatch CLI y adapters de flags (serial)
  ↓
B8 integración, concurrencia, snapshots y UI
```

B1 debe terminar antes de materializar B3/B4/B6A. B6A no puede tocar
`plugin-core-adapter.mjs` ni `bin/climier.mjs`; B6B es quien consume el nuevo
builder. B4 puede paralelizarse únicamente por provider y después de B2.

## 4. Slices candidatos

Las siguientes piezas son candidatas a tasks. Este plan no las crea.

### B1 — contrato del kernel

- Paths: `src/kernel/mutate.mjs`, `src/kernel/transaction.mjs`,
  `src/state.mjs`, `src/lock.mjs`, `src/log.mjs`, tests nuevos de kernel.
- Cambiar: firma de `kernel.mutate`, draft, `tx` tipado, diff de nodos,
  `if_revision`/`if_revisions`, incremento único de revision, persistencia y
  log bajo un único lock.
- Acceptance: provider fixture con `prepare/apply`; creación, update,
  idempotencia, conflicto, multi-nodo y mutación anidada cubierta; ningún
  provider puede modificar revision; task + edges se pueden aplicar juntos.
- Tests mínimos: `node --test test/v2-update.test.mjs
  test/v2-blocked-by.test.mjs test/state-snapshots.test.mjs` más tests nuevos
  del seam.
- No-go: providers, registry, dispatch y UI.

### B2 — grafo y fachada

- Paths: `src/kernel/edges.mjs`, `src/kernel/graph.mjs`,
  `src/v2.mjs`, `src/providers/task/*`, `src/providers/gate/*`,
  `src/providers/knowledge/*` solo para funciones puras extraídas.
- Acceptance: `v2.mjs` re-exporta sin segunda implementación; el mapa de
  funciones del ADR-012 queda verificable; consumers actuales siguen
  resolviendo sus imports.
- Tests mínimos: `node --test test/v2-edges.test.mjs
  test/v2-adversarial.test.mjs`; `npm run test:ui` solo si cambia el consumidor
  directo `ui/server/server.mjs`.
- No-go: mutadores, registry y `bin/climier.mjs`.

### B3 — adapters de mutadores

Se ejecuta en dos olas seriales para limitar el blast radius:

1. `add-task`, `add-node`, `add-edge`, `take`, `update`:
   `test/v2-blocked-by.test.mjs`, `test/v2-edges.test.mjs`,
   `test/v2-take.test.mjs`, `test/v2-update.test.mjs`.
2. `add-gate`, `add-knowledge`, `add-initiative`, `deprecate-knowledge`,
   `add-note`, `resolve`, `release`, `reopen`, `cancel`:
   `test/v2-lifecycle.test.mjs`, `test/v2-supersede.test.mjs`,
   `test/plugin-log-seam.test.mjs`.

Cada handler queda como adapter del provider/kernel. `update` mantiene sus
flags CLI actuales y exige `--if-revision`; `note.add` exige revisión y bump.
No-go: cambiar operation registry o dispatch en estas olas.

### B4 — providers de dominio

- Paths exclusivos: `src/providers/task/*`, `src/providers/gate/*`,
  `src/providers/knowledge/*`, con tests de cada dominio.
- Dependencia: B1+B2+B3.
- Acceptance común: `prepare` valida dominio, `apply` usa únicamente tx,
  lifecycle y proyecciones conservan semántica, errores estructurados y no hay
  acceso a filesystem.
- Task provider: `blocked_by` prepara task + edges atómicamente y clasifica
  `task.take`/`task.takeover`.
- Gate provider: resolución, supersedencia y efectos multi-nodo.
- Knowledge provider: scopes, búsqueda, deprecación e informing.
- Tests: cada provider reusa sus tests `v2-*` existentes y añade solo contratos
  nuevos de provider/kernel necesarios.

### B5 — policy transversal

- Paths: `src/providers/policy/*`, `src/policy.mjs`, tests policy.
- Dependencia: B1+B2+B3.
- Acceptance: `applies` selecciona descriptor por metadata fuera del lock;
  `authorize` corre dentro del lock con snapshot y plan frescos; errores
  `POLICY_DENIED` y allow/deny/abstain se preservan; no hay doble lock.
- Tests mínimos: `node --test test/plugin-policy-parity-cli-api.test.mjs
  test/plugin-policy-concurrency.test.mjs
  test/plugin-policy-seam-dag.test.mjs
  test/plugin-policy-seam-lifecycle.test.mjs
  test/plugin-policy-seam-state-ops.test.mjs`.

### B6A — builder del registry

- Paths: `src/plugin-core-registry.mjs` y su test.
- Dependencia: B1+B2; ownership serial.
- Acceptance: `buildRegistry(providers)` construye entries con `id`, `kind`,
  provider `prepare/apply`; detecta colisiones; no toca adapter ni dispatch;
  no persiste registro.
- Tests mínimos: `node --test test/plugin-core-registry.test.mjs`.

### B6B — adapter `api.core.run`

- Paths: `src/plugin-core-adapter.mjs`, errores y tests de adapter.
- Dependencia: B6A+B5.
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

### B8 — integración

- Paths: tests de integración, snapshots y solo consumidores UI que requieran
  cambios.
- Dependencia: B4+B5+B6B+B7.
- Acceptance: no corrupción bajo concurrencia, snapshots v2 compatibles,
  `newly_ready` y logs correctos, consumers de `v2.mjs` funcionando, fixture
  CLI/API parity.
- Tests: `npm test`, `npm run test:concurrent`,
  `node --test test/state-snapshots.test.mjs test/snapshots-restore.test.mjs` y
  `npm run test:ui` cuando cambia `ui/server/server.mjs` o su contrato directo.

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
