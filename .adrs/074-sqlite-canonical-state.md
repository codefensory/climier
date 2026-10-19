# ADR-074: estado canónico en SQLite embebido con bodies separados

- Gate: `G-adr074` · Deriva de: análisis medido del core (2026-10-19) · Estado: borrador
- Fecha: 2026-10-19

## Contexto

El estado canónico es un único JSON (`~/.climier/projects/<id>/tasks.json`) más
`revision-ledger.json`. Toda mutación reescribe el archivo completo dos veces
(stage + replace) y el ledger una vez, bajo un lock de archivo por proyecto. El
costo por operación es O(estado) y el lock serializa a todos los agentes.

Medido con `bun:sqlite` sobre el mismo estado real (594 nodos, 906 edges, 4.964
log, bodies de referencia) y con la `read-model` real reutilizada:

| métrica | JSON actual | SQLite |
|---|---|---|
| mutación de un nodo + log | 339–470 ms | **5 µs** |
| `status` (consulta) | 2,6–39 ms | **243 µs** |
| frío (abrir + primera consulta) | 39 ms | **0,41 ms** |
| 10 escritores concurrentes | 2.156 ms (215 ms/op) | **64 ms (6 ms/op)** |
| 50 escritores concurrentes | no medido (lock) | **154 ms, 0 pérdidas** |
| `status` salida | — | **byte-idéntica** con la `read-model` actual |

Además: los bodies son el 92% del tamaño (49 MB de 53 MB a 9.600 nodos). Con
bodies fuera del estado caliente, el estado caliente baja a ~4 MB y la escritura
de un ciclo de vida (take/submit/accept, sin tocar body) queda en ~1 µs.

Se descartaron medidas: LMDB (escritura 57 µs, `status` por scan 18,3 ms), Turso
(31 µs / 352 µs, +1 dependencia nativa), libSQL (23 µs / 584 µs, +dependencia),
Cozo (107 µs / 30 ms; clausura transitiva 2.101 ms contra 158 µs de una CTE
recursiva de SQLite), y todo motor nativo que rompa `bun build --compile` de los
5 binarios standalone.

## Decisión

1. **El estado canónico vive en una base SQLite embebida** gestionada con
   `bun:sqlite` (incluido en el runtime: no agrega dependencias y sobrevive a
   `bun build --compile`). `journal_mode=WAL`, `synchronous=NORMAL` (en WAL sólo
   arriesga los últimos commits ante corte de energía, nunca corrupción).
2. **Tablas canónicas**: `meta(k,v)` (revision, schema_version), `node`,
   `node_body` (content-addressed por hash), `edge`, `log`, `initiative`.
   Índices por `(status, kind)`, `edge(dst,type)`, `edge(src,type)` y `log(node)`.
3. **Una mutación es una transacción**: fila de log + cambio de nodo + bump de
   `revision` en el mismo commit. Desaparecen el staging, el fence por generación,
   el `revision-ledger.json` y las verificaciones por sha256 de estado completo.
4. **Los bodies se guardan aparte y se deduplican por hash.** `status`, la
   derivación de readiness y el grafo nunca leen prosa; `show`/`context` la leen
   por hash.
5. **El log se retiene con checkpoint**: se conservan las últimas N entradas más
   un resumen, con política explícita y comando de compactación. Deja de crecer
   sin límite dentro del estado caliente.
6. **Migración explícita, nunca implícita.** `climier state migrate` convierte
   schema-1 JSON a la base, escribe un backup verificado y exige confirmación;
   ningún lector convierte al vuelo. `climier state export` produce el JSON
   schema-1 equivalente para portabilidad, diffs y `restore`.
7. **Un escritor por base.** La base se abre con `busy_timeout`; varios procesos
   pueden escribir serializados por SQLite. El servidor remoto usa
   `BEGIN IMMEDIATE`. WAL no funciona sobre NFS/SMB: compartir una base por
   filesystem queda fuera de soporte y se resuelve con el servidor.
8. **Snapshots con `VACUUM INTO`**: un snapshot consistente en un paso, y
   `restore` abre ese archivo. Se retiran las etapas de commit/replace/recovery.

## Consecuencias

- A favor: 4–5 órdenes de magnitud en mutaciones, latencia plana al crecer el
  DAG, concurrencia real sin locks de archivo huérfanos, y ~1.900 líneas de
  ledger/fence/lock que se borran porque la base ya garantiza atomicidad.
- En contra / deuda: el estado deja de ser un JSON legible (se inspecciona con
  `climier state export` o `sqlite3`); se pierde el `git`-diffeable del archivo,
  aunque el estado nunca vivió en el repo; la base exige un esquema versionado
  (`PRAGMA user_version`) con migraciones testeadas.
- Riesgo: es el reemplazo de la capa más delicada del repo. La migración debe ser
  reversible en la práctica (backup verificado) y validada con crash injection.

## Plan de implementación

1. **Store SQLite detrás de la interfaz de storage actual** — schema, lectura,
   escritura transaccional, `state export`; mismas firmas que `storage/state.ts`.
   Archivos: `src/storage/state.ts`, `src/storage/sqlite/*`, tests nuevos.
2. **Migración y verificación** — `climier state migrate`, backup verificado,
   round-trip `migrate → export` byte-idéntico en el schema-1 equivalente.
3. **Retiro del ledger/fence** — `src/storage/ledger/*`, `src/kernel/mutate.ts`,
   recovery; tests de recovery reemplazados por crash injection.
4. **Bodies content-addressed** — `node_body`, dedupe, lectura por hash en
   `show`/`context`, proyección de `status` sin prosa.
5. **Compactación del log** — checkpoint por política, comando y tests.
6. **Delta sync para clientes remotos** — endpoint "cambios desde revisión N"
   sobre `log`; el cliente mantiene espejo y pide deltas (medido: 10 mutaciones =
   1.331 B contra 5,6 MB de snapshot completo, 0,023%).

## Onboarding breve para crear tasks

- [x] Onboarding realizado — piezas 1 y 2 habilitan todo lo demás y pueden ir
  solas; 3–6 dependen de 1. Corte sugerido: task por pieza, 1 y 2 primero, y el
  resto recién cuando la base canónica esté verde en `main`.

## Verificación

- `npm test` verde; `npm run test:concurrent` verde sobre la nueva base.
- Sobre un proyecto migrado de 6 MB: `add-note` ≤ 30 ms end-to-end, `status`
  ≤ 35 ms, y `status`/`context`/`history` byte-idénticos al JSON migrado.
- 50 escritores concurrentes: sin pérdidas (conteo de filas de log) y sin
  errores de lock.
- Crash injection: `kill -9` durante 100 mutaciones; la base abre, no pierde
  commits confirmados y no queda estado parcial.
- `climier state migrate` sobre una copia del proyecto real + `state export`
  reproducible (dos exportaciones idénticas).
