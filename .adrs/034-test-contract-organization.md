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
4. Reemplazar el glob UI superior por un runner recursivo `test/run-ui-tests.mjs` que seleccione únicamente las suites UI. Ambos runners deben consumir la misma función pura de clasificación (`core`/`ui`), no replicar selectores.
5. `test/test-discovery.test.mjs` importa esa función real, descubre todos los `test/**/*.test.mjs` y afirma que core ∪ UI equivale al inventario y core ∩ UI está vacío; además, lee `package.json` y verifica que scripts `test`/`test:ui` invocan los runners que usan ese selector. Cada archivo debe aparecer exactamente una vez; el test valida descubrimiento sin ejecutar suites como imports.
6. Para cada source dividido, aceptar igualdad exacta del multiconjunto de nombres de `test()` entre source antes y unión de destinos después, además de ejecutar destinos. Source y todos sus destinos se mueven en una task y tienen un solo owner.
7. No renombrar tareas públicas, desactivar suites, editar el contrato de tests para que Oxlint pase ni organizar UI en carpetas nuevas en esta decisión. Referencias documentales a comandos/path movidos sí se actualizan.
8. Cada tarea de split declara paths fuente y destinos, ownership exclusivo y test focal. UI corre `npm run test:ui`; los cambios de frontend incluyen `(cd ui && npm run build)`. Core corre `npm test` cuando el corte afecte runner/contrato compartido; splits pequeños corren sus nuevos destinos además del runner de inventario.

## Consecuencias

- A favor: suites con propósito reconocible, ownership paralelizable y detección automática de omissions/duplicados.
- En contra / deuda: algunas suites conservarán archivos grandes si sus casos comparten fixture/contrato; la migración requiere actualizar documentación y mantener el historial de pruebas repartido.

## Plan de implementación

1. Implementar descubrimiento UI recursivo y test de partición completa/disjunta — único owner de `package.json`, runners y helper de discovery: `package.json`, `test/run-core-tests.mjs`, `test/run-ui-tests.mjs`, helper y `test/test-discovery.test.mjs`.
2. Después del slice 1, partir `test/provider-task.test.mjs` completo en un único task/owner con los destinos `test/providers/task/create-update.test.mjs` y `test/providers/task/lifecycle.test.mjs`, manteniendo el multiconjunto de nombres de tests.
3. Después del slice 1, partir `test/plugin-api.test.mjs` completo en un único task/owner con los destinos `runtime-query.test.mjs`, `data-isolation.test.mjs`, `core-task.test.mjs`, `core-gate.test.mjs`, `core-knowledge.test.mjs` y `compatibility.test.mjs` bajo `test/plugins/api/`. No se paralelizan grupos del mismo source.
4. Después del slice 1, partir `test/server-http.test.mjs` completo en un único task/owner con cuatro destinos bajo `test/server/http/`: `reads-transfers.test.mjs`, `operations-batch.test.mjs`, `auth-validation.test.mjs` y `facade-contract.test.mjs`. Ese owner actualiza también `test/cli-operation-bridge-matrix.test.mjs`: init referencia `auth-validation.test.mjs`, push/pull `reads-transfers.test.mjs`; ejecutar esa matriz focal porque valida `fs.access` de esos paths. Ownership de la matriz queda dentro de este task server, no en otros splits.
5. Tras que termine la task kernel específica de ADR-033 y queden aprobados ADR-034/035, partir `test/kernel-mutate.test.mjs` completo en un único task/owner con los destinos `pipeline.test.mjs`, `policy-concurrency.test.mjs` y `persistence-recovery.test.mjs` bajo `test/kernel/mutation/`. ADR-034 posee exclusivamente ese source y todos sus destinos; no otro ADR lo edita.
6. Actualizar referencias en package/tests/docs dentro del owner del cambio correspondiente y correr los nuevos paths; al cierre `npm test`, `npm run test:ui` y `git diff --check`; UI build solo si cambia frontend.

Cada task registra Oxlint antes/después sobre paths fuente y destinos conforme ADR-035. Ownership de los tests movidos es exclusivo.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el runner core ya descubre recursivamente; el cambio de runner necesario es UI y una comprobación de partición. `kernel-mutate.test.mjs` queda serializado después del ADR-033. Los otros tres archivos de test pueden dividirse en slices por contratos a partir de descripciones de casos y sin tocar assertions.

## Verificación

- Test de inventario usa el selector real consumido por ambos runners, comprueba scripts package y cubre todos los `.test.mjs` exactamente una vez con conjuntos core/UI disjuntos.
- Cada archivo nuevo ejecuta independientemente con `node --test <paths>`; no hay imports/agregadores de otros tests.
- Los runners reales se ejecutan: `npm test` y `npm run test:ui`; UI build cuando el cambio atraviesa frontend.
- Para cada suite partida, el multiconjunto exacto de nombres de casos `test()` en la fuente antes del movimiento es igual a la unión de destinos después; ejecutar destinos. Diffs muestran solo movimiento/setup extraction imprescindible.
- Oxlint por paths y cierre del universo `src bin test` según ADR-035; `git diff --check` limpio.
