# ADR-019: Estado v4, DAG válido, `edge.remove` y CAS global

- Gate: `G-plugin-foundation-dag-adr` · Deriva de: `G-plugin-foundation-rfc` · Estado: borrador
- Fecha: 2026-08-31

## Contexto

El kernel ya crea un draft bajo lock y valida aristas al añadirlas, pero no
rechaza ciclos `BLOCKS` ni centraliza las invariantes completas para mutación y
restore. Sus revisiones son por node: no permiten condicionar una reparación
sobre la lectura completa que la originó. Un plugin o replanner necesita CAS
contra una versión del estado, no contra un subconjunto accidental de nodos.

## Decision

1. El estado pasa a schema v4 y exige `revision`, entero no negativo. La
   migración pura v2→v3→v4 conserva datos y inicializa `revision: 0`. Nuevos
   estados empiezan en 0; versiones futuras se rechazan. `writeState`, init,
   read y restore comparten esta regla.
2. Se define una única validación pura de estado/draft: colecciones requeridas,
   endpoints y tipos de edge, reglas de kind, no self-edge, no duplicados y
   aciclicidad de las aristas `BLOCKS`. `wouldCreateBlocksCycle` es un helper
   puro usado por `tx.addEdge`; la misma validación final cubre estados cargados
   y restaurados. Una infracción de ciclo falla con `CYCLE_DETECTED` y detalles
   deterministas de la arista/ciclo.
3. `edge.remove` es una operación pública en provider core, catálogo
   Application Operations, `api.core` y CLI. Requiere el triple exacto
   `{from,to,type}`; retirar una arista ausente es un no-op idempotente que no
   registra log ni incrementa `revision` global.
4. Todo commit efectivo incrementa `state.revision` exactamente una vez,
   independientemente del número de nodes, edges, iniciativas o data afectados.
   Reads, fallos y no-ops no lo incrementan. Las revisiones por node pueden
   conservarse como control fino existente, pero no sustituyen la revisión
   global.
5. Requests públicos de mutación pueden llevar `if_state_revision`, entero no
   negativo. Se comprueba bajo el lock contra el snapshot fresco, antes de
   policy/apply. Una diferencia falla con `STATE_REVISION_CONFLICT` y
   `{ expected, actual }`, sin log, write ni cambio de revisión.

## Consecuencias

- A favor: los tres caminos (CLI, `api.core` y batch) comparten las mismas
  invariantes y un writer tardío no puede sobrescribir una decisión obsoleta.
- A favor: la migración hace explícito que CAS global es semántica persistida.
- En contra: v4 es incompatible con un binario v3 antiguo y exige adaptar
  snapshots/restore y fixtures.
- En contra: `edge.remove` idempotente no detecta typos; el resultado debe
  exponer `removed: false` para que un caller que requiera strictness lo vea.

## Plan de implementacion

1. Extraer validación pura de estado y ciclo `BLOCKS`, y consumirla desde draft,
   carga y restore — archivos: `src/kernel/{graph,edges,transaction}.mjs`,
   `src/kernel/mutation/validation.mjs`, `src/storage/state.mjs`, state ops y
   tests puros/restore.
2. Introducir v4 `state.revision`, migración y CAS global en la frontera kernel
   y Application Operations — archivos: storage, `kernel/mutation/**`, request
   composition y tests de concurrencia.
3. Añadir provider/registro/API/CLI de `edge.remove` y sus pruebas, una vez que
   el contrato de invariantes y revisión esté disponible.

## Onboarding breve para crear tasks

- [x] Realizado — invariantes/v4/CAS comparten kernel y storage y se mantienen
  en una task fundacional. `edge.remove` queda después en provider/registry/CLI
  para no cruzar simultáneamente el kernel, el adapter y fixtures.

## Verificacion

- Un estado/cambio que forme `T1→T2→T3→T1` por `BLOCKS` falla
  `CYCLE_DETECTED` desde add, batch y restore, y no persiste.
- Dos writers que leen 100: el primero persiste 101; el segundo con
  `if_state_revision:100` recibe `STATE_REVISION_CONFLICT`, sin cambios.
- Un commit multi-node/edge incrementa state revision sólo una vez; no-op,
  fallo y read no la cambian.
- `npm test` y `npm run test:concurrent` quedan verdes.
