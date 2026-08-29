# ADR-011: Graph Kernel y contrato de providers internos

- Gate: `G-graph-kernel-providers-adr` · Deriva de: `G-graph-kernel-providers-rfc` · Estado: aprobado
- Fecha: 2026-08-29

## Contexto

El estado v2 ya es un grafo, pero los handlers mutantes mezclan semántica de
 dominio con locks, persistencia, logs y cambios manuales de `node.revision`.
`G-graph-kernel-providers-rfc` aprobó una frontera única: el kernel es dueño de
la lectura controlada, el lock, el draft, la validación estructural, la
revisión, el log y la persistencia; los providers solo aportan semántica.

Esta decisión no introduce schema v3, tipos persistidos nuevos, transacciones
públicas ni compatibilidad con plugins externos antiguos.

## Decision

### 1. Mutación única

Toda mutación pasa por `kernel.mutate`. El kernel toma el lock del proyecto,
lee el snapshot, ejecuta una operación controlada, valida el draft final y
persiste estado y log atómicamente. Providers, adapters y plugins no pueden
llamar `updateState`, `withLock`, `appendWithContext` ni editar `tasks.json`.

El seam interno es:

```js
provider.prepare({ snapshot, input, request })
  // read-only; devuelve un plan inmutable

provider.apply({ tx, plan })
  // muta solamente el draft; devuelve { result, effects }
```

`prepare` ocurre una sola vez, bajo el lock y contra el snapshot que se va a
mutar. No se persiste nada entre `prepare` y `apply`. No existe `tx.commit()`
público ni una segunda ruta de persistencia.

El flujo canónico es:

```text
seleccionar policy por metadata fuera del lock
→ kernel.mutate(request, selectedPolicy, provider)
→ lock + snapshot
→ provider.prepare(snapshot, input, request)
→ validar if_revision/if_revisions
→ authorize(snapshot, plan.target, plan.policyAction)
→ provider.apply(tx, plan)
→ validar grafo final
→ calcular diff y revisions
→ escribir estado + log
→ devolver result + effects
```

### 2. Transaction draft

`tx` expone únicamente primitivas tipadas:

```text
tx.getNode(id)
tx.createNode(nodeWithoutRevision)
tx.updateNode(id, patch)
tx.addEdge(edge)
tx.removeEdge(edge)
tx.view()
```

El draft permite componer una mutación lógica con múltiples nodos y edges. El
kernel compara el snapshot original con el draft final, ignorando la revisión
para detectar cambios reales:

- un nodo nuevo recibe `revision: 1`;
- cada nodo existente realmente modificado aumenta una sola vez;
- un nodo modificado varias veces dentro del mismo `apply` aumenta una sola vez;
- una operación idempotente no aumenta revisión ni genera log de mutación;
- modificar solo edges no aumenta revisiones de nodos;
- el provider no puede escribir ni incrementar `revision`;
- cualquier intento de mutación pública anidada es rechazado.

La precondición agent-facing se expresa como `if_revision` para un target y
`if_revisions: { id: revision }` para operaciones que modifican varios nodos.
El provider declara en el plan todos los nodos existentes afectados; el kernel
valida sus revisiones bajo el mismo lock antes de autorizar y aplicar.

### 3. Validación y policy

El provider valida restricciones de dominio en `prepare`. El kernel valida la
estructura genérica del grafo después de `apply` y antes de persistir. Por lo
tanto, un blocker inexistente sigue fallando con `INVALID_EDGE_TARGET` antes de
una autorización que requiera un plan de dominio válido.

El policy provider expone:

```text
applies(requestMetadata) → descriptor | null
authorize({ snapshot, target, action, actor, pluginId }) → allow | deny | abstain
```

`applies` y la carga del descriptor ocurren fuera del lock, usando solamente
metadata de la solicitud. El descriptor seleccionado se congela. `authorize`
corre dentro del lock contra el snapshot fresco y el plan preparado. El kernel
no importa ni re-selecciona policies. Una policy que niega produce
`POLICY_DENIED`, sin mutación ni log de éxito.

El provider clasifica la acción de dominio usando el snapshot. Por ejemplo,
`task.take` y `task.takeover` son valores para policy; los logs conservan los
`logAction` core (`take`, `resolve`, `update`, etc.).

### 4. Efectos y operaciones agent-facing

`provider.apply` puede devolver efectos no persistidos, como `newly_ready`,
calculados comparando el snapshot con `tx.view()`. El kernel los devuelve junto
al resultado; cada adapter decide la proyección pública compatible con su
superficie.

Toda operación agent-facing que pueda modificar un nodo existente exige
`if_revision` o `if_revisions`, incluyendo `note.add` y la modificación del
nodo reemplazado por `supersede`. `note.add` incrementa la revisión porque las
notas forman parte del nodo. Las operaciones internas explícitamente confiables
(`restore`, migraciones y mantenimiento) pueden omitir la precondición.

El CLI `update` conserva sus flags de patch actuales y exige `--if-revision`.
La API nueva usa `changes` e `if_revision`. No existe interfaz `before/after` ni
una ruta transitoria que compita con la revisión.

### 5. `task.create` y `blocked_by`

El task provider valida todos los blockers contra el snapshot y prepara el
nodo nuevo más todos sus edges `BLOCKS`. En `apply` usa `tx.createNode` y
`tx.addEdge`; el kernel valida el draft completo y lo persiste una sola vez.
Un blocker faltante, inválido, self-edge o edge estructuralmente inválido deja
el estado sin task ni edges parciales. Los blockers existentes no incrementan
su revisión.

## Consecuencias

- A favor:
  - una única garantía de lock, atomicidad, log y revisión;
  - providers testeables sin filesystem ni conocimiento de persistencia;
  - composición atómica de task + edges y de supersedencias multi-nodo;
  - conflictos optimistas deterministas bajo concurrencia;
  - policy con target fresco sin doble lock;
  - efectos observables sin convertirlos en estado persistido.
- En contra / deuda:
  - el kernel debe mantener un draft y un diff confiable;
  - el contrato `tx` es interno pero compartido por todos los providers;
  - `v2.mjs` seguirá siendo fachada durante la transición;
  - `node.revision` continúa en v2 y tendrá una migración separada;
  - los handlers actuales deben reescribirse o extraerse sin conservar locks
    propios.

## Plan de implementación

1. **Contrato kernel/tx** — archivos: `src/kernel/mutate.mjs`,
   `src/kernel/transaction.mjs`, tests de revisión, diff, lock y errores.
2. **Primitivas de grafo** — archivos: `src/kernel/edges.mjs`,
   `src/kernel/graph.mjs`, tests estructurales.
3. **Fachada v2 y extracción de derivación** — archivos: `src/v2.mjs`,
   `src/providers/task/*`, `src/providers/gate/*`,
   `src/providers/knowledge/*`.
4. **Migración de mutadores** — archivos: `src/commands/*` mutantes; cada
   handler queda como adapter sin lock, persistencia ni incremento manual.
5. **Policy transversal** — archivos: `src/policy.mjs`,
   `src/providers/policy/*`, tests allow/deny/abstain y concurrencia.
6. **Integración** — adapters, UI server, snapshots, concurrencia y paridad
   core según `docs/plans/G-graph-kernel-providers-execution.md`.

## Verificación

- Tests unitarios de `tx`, diff de nodos, edges, revisions y precondiciones.
- `task.create` con cero, uno y múltiples `blocked_by`, incluyendo fallos sin
  estado parcial.
- supersedencia que modifica varios nodos y reescribe edges con un solo bump
  por nodo.
- `note.add`, lifecycle e idempotencia con revisión esperada.
- policy seleccionada fuera del lock y autorizada contra snapshot fresco.
- dos procesos concurrentes sin corrupción ni logs inconsistentes.
- `node --test test/v2-update.test.mjs test/v2-blocked-by.test.mjs`
- `npm test`, `npm run test:concurrent` y `git diff --check`.
