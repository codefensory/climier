# RFC: modularizar responsabilidades grandes y organizar la deuda de Oxlint

- Gate: `G-rar-modular-organization-rfc` · Iniciativa: `remote-architecture-refactor` · Estado: aprobado
- Autor: orchestrator · Fecha: 2026-09-26
- Contexto: continuación de `G-remote-architecture-refactor-rfc`; conserva las capas y contratos ya aprobados

## Problema

La arquitectura por capas de `src/` ya expresa límites útiles entre adapters, Application Operations, providers, kernel, read-model y storage. No se propone reemplazarla. El problema es que algunos módulos internos y suites de tests crecieron hasta mezclar contratos y responsabilidades, lo que hace más difícil localizar cambios, ejecutar verificaciones focales y repartir trabajo sin conflictos.

La evidencia incluye `src/storage/ledger.mjs` (1.346 líneas), `src/kernel/mutation/execute.mjs` (613), `src/kernel/transaction.mjs` (505), `test/plugin-api.test.mjs` (2.161), `test/kernel-mutate.test.mjs` (1.644), `test/provider-task.test.mjs` (1.133), `test/provider-knowledge.test.mjs` (1.071) y `test/server-http.test.mjs` (905). El baseline actual de `npm run lint` (`oxlint src bin test`) informa 1.078 errores en 105 archivos con diagnósticos, de 306 archivos analizados, y 0 advertencias. Las reglas más frecuentes son `curly` (431), `max-lines-per-function` (105), `complexity` (95), `max-nested-callbacks` (94) y `max-statements` (84). La medición usó Oxlint 1.85.0; la UI independiente bajo `ui/` no forma parte de este alcance actual.

El trabajo previo de lint estaba modelado como shards de limpieza por subsistema, separados de las decisiones de diseño. Ese enfoque puede forzar cambios mecánicos en módulos que necesitan primero límites mejores y no hace explícita la obligación de comprobar el lint en cada path que una tarea modifica.

## Objetivos

1. Conservar la arquitectura por capas y modularizar unidades grandes solo por responsabilidades y contratos que puedan nombrarse y probarse.
2. Mantener fachadas/import paths públicos estables cuando se extraigan módulos internos.
3. Separar suites de tests grandes en archivos con una intención verificable, moviendo casos completos y preservando assertions, fixtures y orden cuando sean parte del contrato.
4. Actualizar el descubrimiento de tests cuando cambien sus destinos, sin omitir ni ejecutar dos veces suites core/UI.
5. Exigir que cada tarea de implementación ejecute Oxlint sobre los paths exactos que modifica y no agregue nuevos diagnósticos respecto de su punto de partida, sin autofixes masivos ni suppressions.
6. Mantener visible el estado global de Oxlint y cerrar a cero los diagnósticos del universo acordado antes de proponer un gate CI.
7. Usar ownership por paths exclusivo y verificaciones pequeñas para reducir conflictos entre workers.

## No objetivos

- Reemplazar la arquitectura por capas, introducir una arquitectura nueva o reescribir todo `src/` o `test/`.
- Cambiar contratos CLI/HTTP, semántica de dominio, lifecycle, persistencia, locks, transacciones o el schema de state.
- Extraer código de forma mecánica solo para alcanzar el límite numérico de una regla.
- Mover tests a helpers compartidos solo para bajar el tamaño de un archivo, cambiar assertions sin demostrar una contradicción del contrato, o importar tests desde un agregador.
- Añadir dependencias runtime, framework de tests, `eslint-disable`/suppressions para silenciar deuda o autofix global.
- Activar Oxlint en CI antes de cerrar el baseline global y revisar el impacto por separado.

## Propuesta recomendada

Conservar las capas existentes y dividir de forma incremental los módulos/suites que presenten seams reales. Antes de cada extracción, mapear imports, exports, invariantes y tests asociados. La ubicación y el nombre final de los módulos son decisión de ADR, no una obligación impuesta por este RFC.

### Módulos de producción

Evaluar primero módulos con responsabilidades internas distinguibles, incluyendo:

- `src/storage/ledger.mjs`: separar validación/lectura, migración/recuperación y commit únicamente si la API pública interna puede permanecer como fachada estable y todas las rutas de durabilidad siguen bajo el mismo orden e invariantes. No se permiten varias rutas de escritura ni alterar fencing, recuperación o atomicidad. Antes de extraerlo, una slice de corrección/contrato debe caracterizar y resolver la transición recovery → commit normal → read: se reprodujo que tras `recoverFencedStateUnderLock`, un commit v5 válido y `readFencedState` la lectura falla con `CLIMIER_LEDGER_FINGERPRINT_MISMATCH` porque `last_recovery` conserva el fingerprint anterior y fuerza a recovery explícito contra un source que ya no es legacy. La reparación debe fijar cuándo se invalida/actualiza ese checkpoint y añadir regresión; no debe ocultarse como parte del movimiento de archivos.

ADR-033 debe registrar el grafo de imports que evita el ciclo actual: `state.mjs` usa `import()` dinámico de `ledger.mjs`, mientras ledger consume `stateFile`/`migrateState`; conservar el path fachada y probarlo. La ruta de mutación kernel mantiene `withLock` únicamente en `kernel/mutate.mjs`; `kernel/mutation/execute.mjs` continúa llamando las APIs `*UnderLock` con la capability activa, sin adquirir un segundo lock. Documentar y cubrir las transiciones de `migration_pending`, `commit_pending`, `bootstrap_pending`, `recovery_pending` y `replace_pending`, y cuándo son válidos/invalidables `last_recovery` y `last_replace`, además de la matriz fault-injection/recovery existente.
- `src/kernel/transaction.mjs` y `src/kernel/mutation/execute.mjs`: extraer helpers puros o fases con contratos claros sin mover la propiedad del límite de mutación, lock, validación de draft, revisiones ni commit state+log.
- `src/cli/dispatch.mjs`: considerar parseo, selección de backend, routing y formato de error solo si el código confirma seams independientes; dispatch conserva su contrato y no absorbe semántica de dominio.

Cada extracción debe mantener intacta la dirección de imports definida por el proyecto. Los submódulos nuevos son internos; los consumidores actuales siguen usando la fachada salvo que un ADR justifique lo contrario.

### Suites de tests

Partir los archivos grandes por contratos existentes. Casos completos (setup, acción, assertions y cleanup) se mueven sin alterar su semántica; fixtures permanecen junto a su owner o en un helper solo cuando varios tests realmente comparten el contrato. Candidatos observados:

- `provider-task`: creación/actualización frente a lifecycle;
- `plugin-api`: runtime/query, aislamiento de datos y operaciones core por dominio;
- `server-http`: reads/transfers, operaciones/batch y auth/validación;
- `kernel-mutate`: pipeline, policy/concurrencia y persistencia/recuperación.

La lista final y sus paths exclusivos se concretan en ADRs/tasks tras revisar las suites completas. No se deben renombrar ni modificar contratos de los tests en un split puramente organizativo.

### Descubrimiento y ejecución de tests

El runner core (`test/run-core-tests.mjs`) recorre directorios recursivamente y excluye por prefijo los archivos cuyo nombre empieza por `ui-`. En cambio, `npm run test:ui` usa el patrón superior `test/ui-*.test.mjs`. Si una decisión mueve UI o core a carpetas, los patrones deben adaptarse expresamente y probarse contra el inventario; no se acepta confiar en un glob que silenciosamente no descubra archivos. Añadir una comprobación automatizada de que los conjuntos core/UI cubren cada `*.test.mjs` exactamente una vez (unión completa e intersección vacía). Los cambios limitados a UI conservan `npm run test:ui` y el build cuando aplique; los cambios core ejecutan suites focales y luego `npm test` cuando el blast radius lo requiera. `npm test` por sí solo no verifica la suite UI.

### Oxlint en cada tarea

Cada tarea derivada que edite, mueva, divida o cree código/tests incluye en su aceptación:

1. ejecutar Oxlint 1.85.0 sobre la lista exacta de paths modificados, por ejemplo `./node_modules/.bin/oxlint src/kernel/transaction.mjs src/kernel/transaction/`;
2. registrar el conteo/lista inicial y final de diagnósticos de esos paths; la tarea no agrega diagnósticos y debe corregir los que introduce su cambio;
3. cuando una tarea asume un archivo con deuda preexistente, no se le exige limpiar hallazgos no relacionados con su slice, pero su aceptación reporta el baseline de ese archivo sin regresiones nuevas;
4. no introducir suppressions, `--fix` masivo ni cambios de reglas para hacer pasar la tarea;
5. ejecutar los tests focales y el runner necesario para probar descubrimiento/paridad;
6. registrar los comandos y resultados observados en la nota de entrega.

El baseline se compara sobre paths exactos con la misma versión/configuración. Los archivos nuevos deben quedar en cero. Para cambios que mueven o dividen tests, el destino completo se considera path tocado: mover el caso no permite dejar diagnósticos sin contar. Las tareas que no toquen un path no heredan ownership de su estado local.

El control focal no reemplaza el control global. El universo de cierre de este RFC es exactamente `oxlint src bin test`, equivalente a `npm run lint`; la carpeta independiente `ui/` queda fuera hasta que una decisión la incorpore explícitamente. Al cerrar las slices se vuelve a ejecutar `npm run lint` con Oxlint 1.85.0, se reportan cantidad de diagnósticos y rutas con errores, y las tareas de cierre deben llevar ese universo a cero antes de considerar activar un gate CI. Activar CI requiere decisión explícita posterior y no se deduce automáticamente de este RFC.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener los módulos y solo corregir Oxlint por shards globales | Trabajo directo y fácil de contar | Incentiva extracciones locales sin ownership claro; no resuelve la mezcla de contratos ni organiza suites grandes |
| Reescribir la estructura completa de producción y tests | Consistencia uniforme al final | Gran radio de cambio, rompe ownership y hace más difícil preservar compatibilidad y verificar invariantes |
| Recomendada: preservar capas, modularizar seams gradualmente y hacer lint obligatorio por paths tocados | Alinea estructura, ownership y verificación; cada cambio tiene alcance y aceptación observables | Requiere ADRs para definir seams y cuidado adicional de runners y paths |

## Alcance

- Dentro: módulos internos grandes con seams sustentados por código/tests; partición de suites grandes por contrato; actualización de runners/documentación afectada; lint focal obligatorio para cada tarea y reporte final global.
- Fuera: cambios de comportamiento/producto, activación inmediata de CI, limpieza indiscriminada de todo el repositorio en una sola task y resolución de desacuerdos baseline de contratos ajenos a esta refactorización.

## Riesgos y preguntas abiertas

- Una división mal elegida puede fragmentar invariantes de durabilidad/transacción → revisar imports, orden de operaciones y tests de fallo/concurrencia antes de aprobar cada ADR.
- El recovery fenced tiene un fallo baseline reproducible en recovery → commit normal → read (`CLIMIER_LEDGER_FINGERPRINT_MISMATCH`) → caracterizarlo y corregirlo con prueba antes del split de ledger; mantener esa corrección como slice contractual separada.
- Mover suites puede causar omisiones o ejecución doble → verificar el inventario de archivos descubiertos por cada runner y probar core/UI por separado.
- Archivos grandes pueden tener muchos diagnósticos preexistentes y hacer crecer una tarea → crear slices con ownership exclusivo y evitar limpiar módulos no afectados.
- El baseline global puede cambiar durante la iniciativa → volver a medir con la misma versión/comando y reportar errores y archivos, no solo exit code.
- Definir en ADR si los archivos se organizan por carpetas de dominio bajo `test/` o si algunos splits permanecen temporalmente planos por compatibilidad/ownership.
- Definir en ADR qué slices de producción tienen valor estructural independiente y cuáles deben limitarse a dividir tests y corregir los paths realmente tocados.
- Evitar ownership duplicado: `test/kernel-mutate.test.mjs` puede ser afectado por la modularización kernel y por la organización de tests; cualquier cambio del mismo path se serializa explícitamente o queda en una sola task/owner.
- Los runners actuales no incluyen `ui/src` ni `ui/server` en Oxlint; si aparecen bajo el scope, primero debe fijarse configuración/dependencias y verificarse por separado.

## ADRs derivados (se completa al aprobar)

- [x] ADR-033: modularización de seams de producción preservando fachadas e invariantes → `.adrs/033-modular-production-seams.md`
- [x] ADR-034: organización de suites y descubrimiento de tests. Serializa paths de tests compartidos con ADR-033 → `.adrs/034-test-contract-organization.md`
- [x] ADR-035: política de Oxlint por paths tocados y cierre a cero del universo `src bin test`. Sus criterios bloquean tasks de implementación; el cierre global es una task separada → `.adrs/035-oxlint-touched-path-policy.md`
