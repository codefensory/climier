# ADR-075: acceso puntual por nodo (sin materializar el estado completo)

- Gate: `G-adr075-point-access` · Deriva de: medición del core post SQLite (2026-10-21) · Estado: borrador
- Fecha: 2026-10-21

## Contexto

ADR-074 ya es la realidad del código: SQLite es el único estado canónico, no hay
ledger, no hay lock de archivo y la mutación es una transacción. El store cumple
su parte: no aparece en el perfil de ninguna operación.

Lo que domina el costo es otra cosa. Medido sobre el proyecto real de 6,0 MB (594
nodos, 906 edges, 4.964 log, mediana de 7–9 corridas, bun 1.4.2) contra el piso
de la máquina (`bun -e 0` = 3 ms, `--help` = 16 ms, `status` vacío = 28 ms):

| comando | JSON (antes) | SQLite (hoy) | trabajo real SQLite |
|---|---|---|---|
| `status` | 63 ms | 50 ms | 22 ms |
| `context` | 59 ms | 49 ms | — |
| `add-note` | 139 ms | 98 ms | 70 ms |

Todos los comandos materializan el estado entero —nodos, edges y log parseados a
objetos JS— en cada lectura y en cada mutación. Desglose medido (mismo proyecto,
parseo fila por fila como lo hace el store, mediana de 7 corridas):

| colección | filas | bytes | parse | µs/fila |
|---|---|---|---|---|
| `nodes` | 594 | 2,81 MB | 4,2 ms | 7,0 |
| `log` | 4.964 | 2,52 MB | 3,1 ms | 0,6 |
| `edges` | 906 | 0,07 MB | 0,2 ms | 0,2 |

Dos consecuencias que no eran obvias:

- **`status` no usa el log**: 3,1 ms de su lectura son trabajo descartado.
- **La mutación no escribe una fila**: `replaceRows` ejecuta
  `DELETE FROM meta; DELETE FROM nodes; DELETE FROM edges; DELETE FROM initiatives;
  DELETE FROM log;` y reinserta todo (`src/storage/sqlite/store.ts:268`). Un
  `add-note` borra e inserta 5.558 filas para cambiar una. El costo dominante de
  una mutación no es leer el estado, es **reescribirlo entero**. ADR-074 §Verificación pide
`add-note` ≤ 30 ms y `status` ≤ 35 ms, y hoy no se alcanzan por ese motivo, no por
el motor.

## Decisión

**Opción (a): store de consulta con closure acotado.**

1. El store expone acceso puntual sobre la misma base: `getNode(id)`,
   `nodesByIds(ids)`, `edgesOf(ids, { direction, type })`, `logSince(revision)`,
   `countsBy({ kind, status })` y `revision()`. `readSqliteChangesSince` ya existe
   y se reutiliza.
2. Las lecturas (`status`, `context`, `history`, `search`, `initiatives`) se
   resuelven con esas consultas; el `read-model` sigue siendo puro: recibe las
   vistas ya resueltas, nunca abre la base ni conoce SQL.
3. Las mutaciones cargan el **closure acotado** del objetivo: el nodo, sus edges
   entrantes y salientes, los nodos referenciados por esas aristas, las
   iniciativas y knowledge con scope que la operación declara, y `meta.revision`.
   El kernel arma con eso un snapshot **con la forma actual** (mismo `nodes` /
   `edges` / `initiatives`), así los 22 providers y la derivación de readiness no
   cambian de semántica.
4. Cada operación declara qué necesita: `target`, `blockers`, `refs`,
   `initiatives`, `knowledge`. Ese catálogo es el que calcula el closure y, a la
   vez, el límite de confianza: si una precondición necesita algo que no está
   declarado, el kernel falla cerrado en lugar de leer el estado completo.
5. `withSqliteTransaction` sigue siendo la única frontera de escritura; el
   snapshot acotado se lee **dentro** de la transacción.
6. La mutación escribe solo lo que cambió: la fila del nodo objetivo, la entrada de
   log y `meta.revision`. Desaparece el `DELETE FROM nodes/edges/log` de
   `replaceRows` del camino de mutación; el reemplazo completo queda solo para
   `restore` y `state migrate`.

Lo que no cambia: la forma del estado en disco, los ids, la dirección de `BLOCKS`,
los códigos de error, la salida JSON de cada comando y la garantía de atomicidad.

## Consecuencias

- A favor: latencia plana al crecer el DAG, los objetivos de ADR-074 §Verificación
  al alcance, y menos memoria por operación (hoy se clona el estado entero en cada
  mutación).
- En contra / deuda: el closure es el nuevo lugar donde se puede romper la
  semántica — una arista no cargada convierte una tarea bloqueada en lista sin que
  ningún test lo note. Se mitiga con el catálogo declarado, con el golden de
  paridad y con contadores de trabajo que fallan si se parsea una fila que la
  operación no declaró.
- Riesgo: es la segunda cirugía al núcleo en una semana. Cualquier operación cuyo
  contrato no se pueda expresar como closure vuelve a la mesa antes de escribir
  código.

## Alternativas descartadas

- **(b) Snapshot perezoso**: un `Proxy` sobre el estado que resuelve por query en
  el primer acceso. Ventaja aparente: invisible para providers. Se descarta
  porque es magia no testeable: el contador de trabajo no puede probar qué se
  leyó, el error aparece en el acceso y no en el contrato, y un `JSON.stringify`
  del snapshot dispara el estado completo sin que nadie lo pida.
- **(c) Acceso declarado puro**: cada provider pide explícitamente lo que necesita
  y no recibe snapshot. Se descarta para esta pieza porque obliga a reescribir los
  22 providers y su derivación antes de tener la medición; queda como el destino
  natural de (a) una vez que el catálogo esté probado.

## Plan de implementacion

Cada fila es una task. Colateral medido por comando, ver
`.agents/skills/spec-pipeline/SKILL.md` §Corte y tamaño.

| # | pieza | tipo | paths | colateral | tests | verde | verificar | turnos | depende |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Store de consulta (`getNode`, `edgesOf`, `logSince`, `countsBy`, `revision`) con indices y contadores de trabajo | nuevo | `src/storage/sqlite/store.ts`, `schema.ts` | ~8 tests | primero | si | `EXPLAIN QUERY PLAN` sin `SCAN`, `npm test` | ~60 | — |
| 2 | Lecturas por consulta: `status`, `context`, `history`, `search`, `initiatives` sobre vistas resueltas | cambio | `src/read-model/*`, `src/cli/commands/{status,context,history,search,log,initiatives}.ts` | ~12 tests | mismo slice | si | paridad byte-identica vs golden, `status` ≤ 35 ms | ~70 | 1 |
| 3 | Mutaciones con closure acotado + catalogo declarado + escritura por fila | cambio | `src/kernel/mutation/execute/*`, `src/kernel/transaction.ts`, `src/application/operations/*`, `src/storage/sqlite/store.ts` | ~15 tests | mismo slice | si | `add-note` ≤ 30 ms, filas escritas = nodo + log + meta, 50 writers, filas leidas ajenas = 0 | ~90 | 1 |
| 4 | Golden del proyecto real (export antes del cambio) y test de trabajo por operacion | nuevo | `test/perf-work-budget.test.ts`, fixture | ~4 tests | primero | si | paridad de los 4 comandos | ~30 | — |

## Verificacion

- Golden: `climier state export` del proyecto real de 6,0 MB capturado antes de la
  pieza 2; `status`, `context`, `history` byte-idénticos después.
- Sobre ese proyecto: `add-note` ≤ 30 ms y `status` ≤ 35 ms end-to-end, mediana de
  7–9 corridas, con el mismo piso de máquina documentado arriba.
- Contadores de trabajo: una lectura o mutación de un nodo no parsea filas de
  otros nodos, y una mutación no reescribe filas ajenas (nodo objetivo + 1 entrada
  de log + `meta`); el test falla si aparece una.
- 50 escritores concurrentes sin pérdidas; `npm test` y `npm run test:concurrent`
  verdes.
