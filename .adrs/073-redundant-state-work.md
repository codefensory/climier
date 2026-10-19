# ADR-073: eliminar el trabajo redundante sobre el estado completo

- Gate: `G-adr073` · Deriva de: análisis medido del core (2026-10-19) · Estado: borrador
- Fecha: 2026-10-19

## Contexto

El costo de una mutación no lo pone el disco: lo pone la serialización repetida
del estado completo. Medido sobre el proyecto real de este repositorio
(`b4e2c579bbb81669`: 5,99 MB, 594 nodos, 906 edges, 4.964 entradas de log) con
perfilado de CPU (`bun --cpu-prof`) y contadores instrumentados sobre
`JSON.parse`/`JSON.stringify`/`structuredClone`:

| operación | parses | MB parseados | stringify | structuredClone |
|---|---|---|---|---|
| `status` | 10 | **14,2 MB** (estado ×2) | 2 | 0 |
| `add-note` | 17 | **49,8 MB** (estado ×7) | 5.544 (16,6 MB) | 3.043 (5,8 MB) |
| `batch` de 10 ops | 18 | 41,9 MB | **86.318 → 203,5 MB** | 33.499 → 63,4 MB |

Perfil de un `add-note` de 6,7 MB: `parse` 197,7 ms (40,2%), copias y spreads
77,1 ms (15,7%), `structuredClone` 45,9 ms (9,3%), `stringify` 31,4 ms (6,4%).
Medido end-to-end: `status` 64–66 ms, `context` 65 ms, `history` 68 ms, y
`add-note` 339 ms a 5,6 MB / 713 ms a 12 MB / 1.423 ms a 24 MB (≈55 ms por MB).
Con 10 escritores concurrentes: 2.156 ms totales (215 ms por operación).

Causas localizadas:

- `src/kernel/mutation/revisions.ts:11` compara valores con
  `JSON.stringify(a) === JSON.stringify(b)`, nodo por nodo y edge por edge.
- `src/storage/ledger/stages.ts:78-80` serializa el **estado completo** dos veces
  para verificar que una migración de esquema no cambió datos.
- El diff de una mutación recorre todo el estado aunque cambie un solo nodo.
- La ruta de mutación lee y parsea el estado varias veces (lectura, verificación
  del ledger, stage de commit, fingerprint).

El I/O real de una mutación de 6,3 MB es ~10 ms (dos escrituras con fsync,
medido). El resto es trabajo evitable.

## Decisión

1. **Lectura única por mutación.** El kernel lee y parsea el estado una sola vez
   y reutiliza el objeto parseado en la verificación del ledger, el plan de
   proveedor, el diff y el commit. Toda verificación que hoy re-lee el archivo
   recibe el estado ya cargado.
2. **Comparación estructural, no serialización.** `deepEqualValue` y toda
   comparación de nodos, edges e iniciativas usan un comparador estructural sobre
   los campos del registro (claves ordenadas, sin construir strings). Prohibido
   `JSON.stringify` como igualdad en `src/kernel/` y `src/storage/`.
3. **Diff por conjunto sucio.** El diff recorre sólo los ids que el proveedor
   tocó (nodos, edges, iniciativas), no el estado completo. Los ids sucios los
   expone el draft de la transacción.
4. **La verificación de migración sólo corre con migración pendiente.**
   `assertSchemaMigrationDestination` y su comparación de estado completo se
   ejecutan únicamente cuando `commit_pending`/`schema_only_migration` lo
   declaran; en el caso normal no se comparan dos estados completos.
5. **Sin cambio de formato ni de superficie.** El estado sigue siendo el JSON
   schema-1 con `revision-ledger.json`; `status`/`context`/`history` conservan
   su salida byte a byte. No se agregan dependencias.
6. **Los contadores quedan como test de regresión.** Un test instrumenta
   `JSON.parse`/`JSON.stringify`/`structuredClone` y falla si una mutación
   parsea más de 2 veces el estado o serializa más de 2 veces su tamaño.

## Consecuencias

- A favor: ~5x en mutaciones y ~2x en lecturas con un cambio local, sin tocar el
  formato, sin migración y sin dependencias. Reduce el tiempo bajo lock, que es
  lo que hoy serializa a los agentes.
- En contra / deuda: sigue siendo O(estado) por mutación; el techo real no se
  mueve hasta ADR-074. El comparador estructural debe cubrir exactamente los
  mismos casos que la comparación por stringify (incluido `undefined` vs clave
  ausente), o cambia la semántica del diff sin que nadie lo note.
- Riesgo: tocar el diff y la verificación del ledger es zona delicada. Cada
  pieza va con tests de equivalencia antes del cambio y la suite completa verde.

## Plan de implementación

1. **Comparador estructural + migración sólo cuando corresponde** — archivos:
   `src/kernel/mutation/revisions.ts`, `src/storage/ledger/stages.ts`,
   `src/storage/ledger/commit.ts`.
2. **Lectura única por mutación** — archivos: `src/kernel/mutate.ts`,
   `src/kernel/mutation/execute/{state,provider,batch}.ts`,
   `src/storage/ledger/commit.ts`.
3. **Diff por conjunto sucio** — archivos: `src/kernel/mutation/diff.ts`,
   `src/kernel/transaction.ts`.
4. **Test de regresión con contadores** — archivos: `test/state-work-budget.test.ts`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el alcance son las tres piezas 1–3 más el test de
  regresión; no hay ambigüedad de contrato porque el formato no cambia. Corte
  sugerido: una task por pieza, encadenadas, porque comparten `commit.ts` y el
  resultado de una reduce el ruido de medición de la siguiente.

## Verificación

- `npm test` verde, incluidos `test/take.test.ts`, `test/concurrent-takes.test.ts`
  y los tests de ledger/recovery.
- Sobre el fixture de 6 MB: `add-note` ≤ 120 ms y `status` ≤ 45 ms (medidos con
  `date +%s%N` alrededor del comando, tres corridas).
- Contadores del test de regresión: ≤ 2 parses del estado y ≤ 2× el tamaño del
  estado en bytes serializados por mutación.
- Salida de `status`, `context` y `history` byte-idéntica contra la captura
  previa al cambio.
