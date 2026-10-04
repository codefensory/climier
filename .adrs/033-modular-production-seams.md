# ADR-033: modularizar seams de producción preservando fachadas e invariantes

- Gate: `G-rar-modular-organization-adr-033` · Deriva de: `G-rar-modular-organization-rfc` · Estado: aprobado
- Fecha: 2026-09-26

## Contexto

El RFC aprobado propone reducir responsabilidades mezcladas sin cambiar las capas ni los contratos observables. Los candidatos de mayor radio son `src/storage/ledger.mjs` y `src/kernel/mutation/execute.mjs`; `src/kernel/transaction.mjs` es largo, pero concentra una closure transaccional única. La extracción del ledger es especialmente sensible: `state.mjs` usa import dinámico para el seam ledger/fencing, el ledger consume helpers de state, y el kernel ya posee un único límite `withLock`.

RFC fuente: `.decisions/G-rar-modular-organization-rfc.md`.

## Decisión

1. Conservar los imports públicos actuales y las fachadas `src/storage/ledger.mjs`, `src/kernel/mutation/execute.mjs` y `src/kernel/transaction.mjs`. Consumidores existentes no importan submódulos internos nuevos.
2. Modularizar el ledger en submódulos privados por seams que existan en el código: validación/transformaciones puras, primitivas durable-stage/replace y grupos de operaciones pending/commit, recovery y replace. La fachada conserva los exports actuales. El corte exacto de helpers puede ajustarse al revisar el grafo, pero no se divide un protocolo pending entre owners sin un contrato explícito.
3. Modularizar el coordinador de mutación por sus límites actuales: helpers compartidos, batch mutation, state-operation mutation y flujo provider mutation. `executeMutation` continúa siendo la entrada de ejecución llamada por el kernel; todas las rutas reciben el lock capability activo.
4. No extraer `withLock`, ni crear otro lock path. `kernel/mutate.mjs` sigue siendo owner de la adquisición del lock y re-entrancy. El flujo fenced de `execute.mjs` y sus submódulos recibe la capability activa y usa APIs `*UnderLock`. Las state-operations legacy conservan por ahora sus llamadas a `readState`/`writeState`, cuyos wrappers son reentrantes mediante ALS; la aceptación prueba que bajo la entrada única de `mutate` no se adquiere una segunda lock file. No cambiar silenciosamente el ownership de esa ruta como parte de un split.
5. No dividir `createTransaction` en este ADR. Sus operaciones comparten estado mutable cerrado (`draftNodes`, `draftEdges`, iniciativas y plugins); el split solo se reabre si aparece un seam puro comprobable, no para satisfacer contadores de líneas.
6. Antes de extraer ledger, corregir como slice contractual separada recovery → commit fenced normal → read, recovery → replace fenced → read/retry y recovery sin candidate → crash después de pending → read/retry. Para checkpoint stale, `commitFencedStateUnderLock` elimina `last_recovery` en la misma persistencia durable que instala `commit_pending`; `replaceUnderActiveLock` lo elimina en la persistencia que instala `replace_pending`. Así, tras crash el reader prioriza/reanuda el pending durable sin confundir el nuevo state con source legacy. `finishPendingReplace` registra su `last_replace`; las lecturas posteriores validan state/ledger normalmente. Añadir fault tests en after-pending y retry para las dos rutas.
7. `recoverFencedStateUnderLock(lock, undefined)` es un modo soportado que recupera del source/stage durable y no tiene candidate de entrada. Mantener `recovery_pending.input_sha256: null` como registro válido únicamente para ese modo, para que también sean reanudables ledgers ya escritos con null; un candidate explícito debe seguir llevando SHA-256 válido. Añadir test con fixture durable `recovery_pending.input_sha256: null` que pase por `assertValidLedger` y recupere/reintente tras crash; no basta con dejar de crear nuevos null.
8. Preservar el ciclo actual de dependencias: `state.mjs` conserva su `import()` dinámico del ledger para no crear un ciclo de evaluación estática; submódulos no inicializan I/O al importarse. `ledger.mjs` mantiene el path/fachada y puede delegar internamente.
9. Preservar los cinco estados pending (`migration_pending`, `commit_pending`, `bootstrap_pending`, `recovery_pending`, `replace_pending`), sus exclusiones mutuas, orden de escrituras, puntos fault-injection, limpieza de stage files, semántica de `last_recovery`/`last_replace`, fencing/high-water y matriz crash-retry. Las escrituras state+ledger conservan su orden durable.
10. La entrada kernel adquiere el lock en `kernel/mutate.mjs`. El flujo fenced de provider/batch/state operations recibe lock capability; sus llamadas `readState` y `writeState` existentes son wrappers legacy reentrantes bajo ALS y no adquieren un segundo lock file. Se permiten como excepción explícita de compatibilidad en este ADR; no se amplía esa superficie. Pruebas mantienen read de v5 a través de esa ruta, writes legacy y ausencia de segundo lock file. Una futura migración a APIs UnderLock requiere decisión aparte.
11. Excluir de este ADR la descomposición de `cli/dispatch.mjs`: su parsing, help, selección de backend, routing y errores requieren un mapa de ownership separado. Solo se abre otro ADR si se demuestra una responsabilidad independiente con tests.

## Consecuencias

- A favor: disminuye tamaño de los coordinadores sin alterar las fachadas ni mover autoridad transaccional; las APIs bajo lock siguen siendo explícitas.
- En contra / deuda: la extracción del ledger es secuencial y exige conservar pruebas fault-injection; el bug recovery→commit→read debe corregirse antes; `transaction.mjs` y `dispatch.mjs` siguen siendo grandes hasta una decisión posterior sustentada.

## Plan de implementación

1. Caracterizar y corregir recovery → commit normal → read, recovery → replace → read/retry, y recovery sin candidate → after-pending → read/retry — archivos: `src/storage/ledger.mjs`, `test/storage-ledger-recovery.test.mjs`, `test/storage-ledger-replace.test.mjs`. Red/green demostrado antes de extraer.
2. Extraer recovery + validación/finish de recovery como una unidad durable con paths explícitos, manteniendo exports por fachada — archivos privados propuestos: `src/storage/ledger/recovery.mjs`, `src/storage/ledger/stages.mjs`; source facade: `src/storage/ledger.mjs`; tests `test/storage-ledger-recovery.test.mjs`. Depende de 1.
3. Extraer commit/migration/bootstrap + validación pending como unidad, sin dividir el protocolo durable — archivos privados: `src/storage/ledger/commit.mjs`, `src/storage/ledger/migration.mjs`, `src/storage/ledger/bootstrap.mjs`; fachada y tests ledger/commit/state-read. Depende de 2; un owner a la vez sobre `ledger.mjs` y `src/storage/ledger/**`.
4. Extraer replace y stage retry como unidad — `src/storage/ledger/replace.mjs`, fachada y `test/storage-ledger-replace.test.mjs`; depende de 3 y corre en serie con las otras extracciones ledger.
5. Separar `execute.mjs` en fases batch/state/provider con destinos explícitos `src/kernel/mutation/execute/batch.mjs`, `state.mjs`, `provider.mjs`, `shared.mjs`; source `src/kernel/mutation/execute.mjs`; no editar `test/kernel-mutate.test.mjs` (ADR-034 posee ese source). Esta línea de producción puede paralelizarse con ledger una vez cerrada la task 1 porque no comparte paths.
6. Verificar por slice con `node --test test/storage-ledger*.test.mjs test/storage-state-read-v5.test.mjs` y `node --test test/kernel-mutate*.test.mjs test/kernel-mutation-batch.test.mjs test/kernel-state-operations.test.mjs`. Al cierre: `npm test`, `npm run test:concurrent`, `npm run pack:check` y `git diff --check`.

Cada task registra Oxlint antes/después sobre sus paths exactos conforme a ADR-035; sin suppressions ni autofix masivo.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el ledger forma una máquina durable con cinco `*_pending`; `execute.mjs` ya delega a `diff.mjs`, `validation.mjs`, `request.mjs` y `log-entry.mjs`; el corte más defendible son las funciones existentes de batch/state/provider. El fix de recuperación es independiente de mover archivos. Los paths fuente son secuenciales y requieren owners exclusivos.

## Verificación

- Imports públicos y exports de ledger/kernel conservan resultados y resolución por sus fachadas.
- Regresión recovery → commit → read: primero se demuestra fallo, luego pasa tras la corrección.
- Suites storage-ledger (`test/storage-ledger*.test.mjs`, `test/storage-state-read-v5.test.mjs`) conservan fault matrix y retry.
- Suites kernel (`test/kernel-mutate*.test.mjs`, operaciones/batch y concurrency) conservan atomicidad state+log, policy bajo snapshot fresco, CAS, re-entrancy y una sola capability de lock.
- `npm test`, `npm run test:concurrent`, `npm run pack:check`, Oxlint por paths tocados y `git diff --check` pasan según ADR-035.
