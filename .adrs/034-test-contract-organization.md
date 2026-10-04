# ADR-034: organizar suites por contrato y garantizar su descubrimiento

- Gate: `G-rar-modular-organization-adr-034` · Deriva de: `G-rar-modular-organization-rfc` · Estado: aprobado
- Fecha: 2026-09-26

## Contexto

Varias suites core agrupan contratos distinguibles y crecieron a cientos o miles de líneas. El runner core recorre `test/` recursivamente y excluye archivos cuyo basename comienza por `ui-`; el comando UI usa un glob de nivel superior. Mover tests sin una partición verificable puede omitir o duplicar casos. `test/kernel-mutate.test.mjs` además se solapa con el ADR-033, que extrae el coordinador de mutación.

RFC fuente: `.decisions/G-rar-modular-organization-rfc.md`.

## Decisión

1. Partir suites moviendo tests completos con setup, asserts y cleanup sin reescribir expectativas ni crear agregadores que importen otros tests. Un módulo compartido solo se crea si contiene helpers usados realmente por más de una suite.
2. Mantener carpetas por contrato bajo `test/` para los grupos que se muevan:
   - `test/providers/task/create-update.test.mjs` y `lifecycle.test.mjs`;
   - `test/plugins/api/runtime-query.test.mjs`, `data-isolation.test.mjs`, `core-task.test.mjs`, `core-gate.test.mjs`, `core-knowledge.test.mjs` y `compatibility.test.mjs`;
   - `test/server/http/reads-transfers.test.mjs`, `operations-batch.test.mjs`, `auth-validation.test.mjs` y `facade-contract.test.mjs`;
   - `test/kernel/mutation/pipeline.test.mjs`, `policy-concurrency.test.mjs` y `persistence-recovery.test.mjs`.
   Los límites exactos de los casos se anotan en las tasks después de inspeccionar imports/helpers compartidos; no se añaden carpetas si una suite no obtiene un ownership más claro.
3. ADR-034 es el único owner de editar/mover `test/kernel-mutate.test.mjs`; empieza después de que cierre la task ADR-033 que separa `execute.mjs` (no requiere esperar las extracciones ledger, que no comparten esos paths). ADR-033 no cambia ese archivo para introducir tests de extracción: usa tests existentes o crea una prueba nueva en paths ledger dedicados. Esta dependencia elimina la colisión.
4. La propuesta de reemplazar el glob UI superior por un runner recursivo `test/run-ui-tests.mjs` y compartir el selector `core`/`ui` quedó cancelada por decisión del usuario; no cambiar runners ni scripts UI sin autorización explícita.
5. La propuesta de añadir `test/test-discovery.test.mjs` para inventariar conjuntamente core y UI quedó cancelada con `T-rar-mod-test-discovery`, porque su aceptación requería ejecutar `npm run test:ui`. Los archivos `test/ui-*.test.mjs` permanecen en el árbol raíz `test/` y continúan dentro del alcance de Oxlint; no se deshabilitan ni se omiten del lint. Las particiones core se desacoplan de esta task cancelada y permanecen ejecutables con sus acceptance focales sin test:ui.
6. Para cada source dividido, aceptar igualdad exacta del multiconjunto de nombres de `test()` entre source antes y unión de destinos después, además de ejecutar destinos. Source y todos sus destinos se mueven en una task y tienen un solo owner.
7. No renombrar tareas públicas, desactivar suites, editar el contrato de tests para que Oxlint pase ni organizar UI en carpetas nuevas en esta decisión. Referencias documentales a comandos/path movidos sí se actualizan.
8. Cada tarea de split declara paths fuente y destinos, ownership exclusivo y test focal. Los splits de suites UI se cancelaron por decisión del usuario y no deben ejecutarse ni reactivarse sin nueva autorización; los archivos `test/ui-*.test.mjs` permanecen dentro del scope de Oxlint porque viven bajo `test/`. Los cambios de frontend y `npm run test:ui` requieren autorización explícita. Core corre `npm test` cuando el corte afecte runner/contrato compartido; splits pequeños corren sus nuevos destinos.

## Consecuencias

- A favor: suites con propósito reconocible, ownership paralelizable y detección automática de omissions/duplicados.
- En contra / deuda: algunas suites conservarán archivos grandes si sus casos comparten fixture/contrato; la migración requiere actualizar documentación y mantener el historial de pruebas repartido.

## Plan de implementación

1. Cancelado por decisión del usuario porque su acceptance exige `npm run test:ui`; no reactivar ni ejecutar sin autorización explícita. Las tareas core siguientes se desacoplan de este slice UI.
2. Partir `test/provider-task.test.mjs` completo en un único task/owner con los destinos `test/providers/task/create-update.test.mjs` y `test/providers/task/lifecycle.test.mjs`, manteniendo el multiconjunto de nombres de tests; no requiere ejecutar suites UI.
3. Partir `test/plugin-api.test.mjs` completo en un único task/owner con los destinos `runtime-query.test.mjs`, `data-isolation.test.mjs`, `core-task.test.mjs`, `core-gate.test.mjs`, `core-knowledge.test.mjs` y `compatibility.test.mjs` bajo `test/plugins/api/`. No se paralelizan grupos del mismo source ni se requiere ejecutar suites UI.
4. Partir `test/server-http.test.mjs` completo en un único task/owner con cuatro destinos bajo `test/server/http/`: `reads-transfers.test.mjs`, `operations-batch.test.mjs`, `auth-validation.test.mjs` y `facade-contract.test.mjs`. Ese owner actualiza también `test/cli-operation-bridge-matrix.test.mjs`: init referencia `auth-validation.test.mjs`, push/pull `reads-transfers.test.mjs`; ejecutar esa matriz focal porque valida `fs.access` de esos paths. Ownership de la matriz queda dentro de este task server, no en otros splits. No se requiere ejecutar suites UI.
5. Tras que termine la task kernel específica de ADR-033 y queden aprobados ADR-034/035, partir `test/kernel-mutate.test.mjs` completo en un único task/owner con los destinos `pipeline.test.mjs`, `policy-concurrency.test.mjs` y `persistence-recovery.test.mjs` bajo `test/kernel/mutation/`. ADR-034 posee exclusivamente ese source y todos sus destinos; no otro ADR lo edita. No se requiere ejecutar suites UI.
6. Actualizar referencias en package/tests/docs dentro del owner del cambio correspondiente y correr los nuevos paths; al cierre `npm test` y `git diff --check`. `npm run test:ui` y UI build quedan fuera de alcance sin autorización explícita.

Cada task registra Oxlint antes/después sobre paths fuente y destinos conforme ADR-035. Ownership de los tests movidos es exclusivo.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el runner core ya descubre recursivamente; el split del runner UI y la comprobación de partición core/UI quedaron cancelados por decisión del usuario. `kernel-mutate.test.mjs` queda serializado después del ADR-033. Los otros tres archivos core pueden dividirse en slices por contratos a partir de descripciones de casos y sin tocar assertions.

## Verificación

- La cobertura de inventario core/UI y la ejecución de `npm run test:ui` están canceladas; requieren nueva autorización explícita. Los archivos `test/ui-*.test.mjs` permanecen en el scope de Oxlint y su deuda se asigna a `T-rar-lint-test-ui-files`, sin ejecutar esos tests.
- Cada archivo core nuevo ejecuta independientemente con `node --test <paths>`; no hay imports/agregadores de otros tests. Ejecutar `npm test` cuando el corte afecte runner o contrato compartido.
- UI build queda fuera de alcance salvo autorización explícita para cambios de frontend.
- Para cada suite core partida, el multiconjunto exacto de nombres de casos `test()` en la fuente antes del movimiento es igual a la unión de destinos después; ejecutar destinos. Diffs muestran solo movimiento/setup extraction imprescindible. Los splits UI están cancelados.
- Oxlint por paths y cierre del universo `src bin test` según ADR-035; `git diff --check` limpio.

## Enmienda (v1-baseline, T-v1-ui-delete)

El slice 5 de ADR-039 eliminó la suite UI raíz: los catorce `test/ui-*.test.mjs`,
`test/jsx-loader.mjs`, el script `test:ui` y el andamiaje JSX/overview. Por eso
las decisiones 5, 8 y 10 de este ADR quedan superadas en lo que se refiere a
esos paths: ya no existen, no están en el alcance de Oxlint y no hay deuda de
lint que limpiar en ellos. `T-rar-lint-test-ui-files` se canceló por esa razón.
El resto del ADR (particiones core, ownership exclusivo, verificación focal)
sigue vigente.
