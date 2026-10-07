# RFC: big bang hacia v1 — un solo esquema, sin compatibilidad, listo para publicar

- Gate: `G-v1-baseline-rfc` · Iniciativa: `v1-baseline` · Estado: aprobado (ronda 3 adoptó el big bang por decisión del dueño; ronda 4 cerró las preguntas abiertas en los cinco ADR derivados)
- Autor: orchestrator · Fecha: 2026-09-27
- Contexto: rondas 1 y 2 con notas de las lentes arquitectura, producto y ejecución en el gate. Esta ronda adopta la opción C por decisión del dueño y conserva las mitigaciones que esas lentes exigieron.

## Decisión del dueño (ronda 3)

Big bang. Cero compatibilidad con cualquier forma anterior. Todo renumerado a **1**. Los tests `ui-*` vuelan. Objetivo declarado: dejar el proyecto listo para producción.

Un dato hace que la historia cierre sin ambigüedad: **nada de esto se publicó nunca**. `npm view climier version` responde `404`, y no existe tag de release (el único tag del repo es `archive/graph-kernel-log-fields-7dd34ef`). El `1.0.0` del `package.json` y la entrada `[1.0.0]` del CHANGELOG son registro interno, no un artefacto publicado. Por lo tanto no hay consumidor externo que romper, y el corte **es v1.0.0**: la primera versión limpia, con el esquema de estado en 1, todo bajo el mismo número.

Consecuencia de diseño: "todo en 1" pasa a ser literal y coherente en todas las capas, porque nada quedó atrás con un número distinto.

| Capa | Hoy | Después del corte |
|---|---|---|
| Esquema de estado | 5 (fenced) | **1** |
| Payload de transferencia | 4 | **1** |
| API de plugins | 3 | **1** |
| Core API expuesta al host de plugins | 2 | **1** |
| `.climier.json` | 1 | 1 (sin cambio) |
| Ledger de revisiones | 1 | 1 (sin cambio) |
| Protocolo HTTP remoto | 1 | 1 (sin cambio) |
| Versión del paquete | 1.0.0 sin publicar | **1.0.0**, la primera publicación real |

## Decisiones del dueño (ronda 4)

Las cinco preguntas que los ADR derivados dejaron abiertas quedaron resueltas por el dueño el 2026-09-27, cada una registrada en su ADR:

| Pregunta | Decisión | Dónde quedó |
|---|---|---|
| Suerte de `climier ui` en el producto publicado | Entra como **experimental** —va a seguir cambiando—: fuente y comando se quedan, con etiqueta y fallo accionable en el artefacto | ADR-040 §Decisión 8, ADR-039 §Decisión 8 |
| Snapshots que acepta `restore` | **Solo v1**; los históricos 2/3/4/5 se rechazan apuntando al importador | ADR-036 §Decisión 10 |
| `update --backlog true\|false` | **Entra al contrato tipado** (`backlog` en `ALLOWED_PATCH_KEYS`); `--meta` sale con lo retirado | ADR-038 §Decisión 4 |
| URLs de publicación (`repository`, `homepage`, `bugs`) | **Ninguna** en este corte; el tag y el `npm publish` los corre el dueño | ADR-040 §§Decisiones 1, 2 y 5 |
| Autoridad de `climier migrate` | **Sin `--as`**: camino de mantenimiento con actor de sistema fijo en el log | ADR-037 §Decisión 1 |

Con esto no queda ninguna pregunta abierta en este RFC ni en los cinco ADR derivados: los cinco gates de ADR quedan listos para aprobar y materializar tasks.

**Criterio de autoridad (corregido en la ronda 4).** Este corte **no** decide qué queda en la superficie por lo que dice la documentación. La jerarquía es: el estado y el ledger en disco > los contratos de provider y la derivación > la superficie ejecutable (`knownFlags`, el routing por kind, las allowlists, los envelopes) > los tests > las docs. Las docs entran como **inventario de drift a sincronizar** y como objetivo del check de coherencia, nunca como la razón de una decisión: el check de superficies retiradas se genera del código, no se escribe a mano desde una doc, o hereda el error. Un test que fija un literal de doc es el mismo vicio un nivel más arriba (caso `test/v2-docs.test.mjs:11`, que este corte retira). Aplicado al corte, el error ya estaba cometido en una decisión de ADR-038 §4 y quedó corregida contra el código.

## Problema

El proyecto ya no es el CLI pequeño que describen sus propias docs: `src/` son 21.500 líneas con servidor HTTP, ledger de revisiones con fence, backend remoto multi-proyecto, plugins instalables y manifest de protocolo; la suite core supera las 42.600 líneas en 188 archivos. Pero el esquema en disco va por la **versión 5** y el código carga la lane completa de aceptación y migración de los esquemas 2, 3 y 4.

**1. Dos cosas distintas se llaman "v2" y la etiqueta tapa la deuda real.** Los 22 archivos `test/v2-*.test.mjs` (~7.700 líneas) no prueban versiones viejas: "v2" es la etiqueta de era de los features F1–F13, y adentro se asertan contratos actuales. Todos llaman `init({ flags: { v2: true } })` y ese flag **no existe** en ningún `knownFlags` de `src/` ni `bin/`; las 39 ocurrencias de `v2: true` son inertes y `init --v2` falla como unknown flag.

**2. La lane de compatibilidad de esquema está embebida en la suite.** `src/storage/state.mjs:52-55` declara el esquema en cuatro números: `CURRENT_STATE_VERSION = 4`, `FENCED_STATE_VERSION = 5`, `LEGACY_STATE_VERSION = 2`, `PREVIOUS_STATE_VERSION = 3`. `migrateState` (`:64-67`) normaliza 2 y 3 a 4 reseteando `revision`; `isV2State` (`:80-82`) acepta `[2,3,4]`; `assertStateVersion` (`:88-92`) acepta el literal `2` para un estado v4. En la suite, **57 de 188 archivos core** escriben literales `version: 2|3|4` y la fixture compartida `exampleStateFixture` (`test/helpers.ts:133-188`) es `version: 2` con **30 llamadas** en 6 suites.

**3. El arranque de un proyecto nuevo pasa por la lane legacy, en dos seams.** Seam A (el normal): `init` persiste un `version: 4` sin ledger (`src/kernel/mutation/execute/state.mjs:137-143,173-194`, `src/kernel/state-operations.mjs:93-105`); la siguiente operación lo lee por `readFencedStateUnderLock` → `bootstrapLocked`/`prepareMigration`, que lo materializa como fuente v4 y lo fenced a v5 (`src/storage/ledger.mjs:56-70,118-138`, `src/storage/ledger/bootstrap.mjs:185-255,269-348`). Seam B (el implícito): la degradación a v4 de `persistMutation` (`src/kernel/mutation/execute/provider.mjs:24-39,132-167,188-200`) corre cuando no hay estado y `initiative.create` puede hacer bootstrap implícito (`src/providers/core/initiative.mjs:211-218`). La lane no es peso muerto: es el camino de arranque.

**4. El parque de estados vivos no es un caso de borde, pero está mucho menos cargado de lo que parece.** Medido en el `CLIMIER_HOME` del dueño: 46 directorios de proyecto, 40 con estado, 20 no vacíos, 1.026 nodos y 7.950 entradas de log. Distribución real por esquema en disco:

| Esquema en disco | Proyectos | Nodos | Entradas de log |
|---|---|---|---|
| `1` prehistórico (`tasks`/`decisions`/`gotchas`) | 5 | **0** | **0** |
| `2` | 29 | 113 | 778 |
| `4` sin ledger | 4 | 146 | 1.421 |
| `5` fenced | 2 | 767 | 5.751 |

Dos hechos cambian el plan. Primero: los 5 proyectos en `version: 1` están **vacíos**, así que no hay datos atrapados que rescatar y el mapeo semántico `decisions` → gates y `gotchas` → knowledge **no hace falta**; alcanza con reconocer la forma y escribir un estado canónico vacío. Segundo: los dos proyectos que concentran el 75% de los nodos y el 72% del log (505 y 262 nodos) son justamente los dos que ya están fenced y al día, es decir que el camino crítico del importador es el que preserva ledger y CAS, no el de las formas viejas. Los otros 33 proyectos juntan 259 nodos: parque viejo, mayormente vacío.

**5. El número 1 está ocupado, y ahora convive con la decisión de usarlo.** El rechazo prehistórico es **numérico** (`src/storage/state.mjs:101-121,218-226` y la sonda duplicada de `src/kernel/mutation/execute/shared.mjs:298-320`), así que la discriminación entre el v1 prehistórico y el v1 canónico tiene que ser **por forma**, no por número.

**6. La documentación está dos o tres versiones atrás, y hay artefactos duplicados.** `AGENTS.md:99` y `:171` dicen `version: 3`; `docs/reference.md:64,68,86,804,813,818` dicen v2/v3 y `:870` documenta el rechazo de v1; `README.md:226` dice `version: 3`; `CLIMIER-CHEATSHEET.md:3` dice `{ version: 2, ... }` y `:39` "Validates target v2". `AGENTS.md` — la spec que leen los agentes — describe un proyecto sin `src/server/`, sin `src/storage/ledger/`, sin `src/application/backend-*`, sin `src/cli/commands/internal/` y sin manifest remoto. Hay tres copias divergentes de los prompts de agentes (`.pi/agents/*.md`, `.zcode/agents/*.md`, `.agents/skills/*/SKILL.md`) y dos copias divergentes del skill de climier (`skills/climier/SKILL.md` de 115 líneas frente a `.agents/skills/climier/SKILL.md` de 367).

**7. La suite UI se va.** Decisión del dueño: no hay interés en la UI ahora y se refactorizará más adelante. Hoy son 14 archivos trackeados más su andamiaje (`test/jsx-loader.mjs` y los helpers de JSX/overview) que `npm test` no ejecuta: el runner core los excluye por prefijo (`test/run-core-tests.ts:15`) y solo `npm run test:ui` los corre (`package.json:23`). Quedan muertas la exclusión del runner y el script, y la tarea `T-rar-lint-test-ui-files` (hoy `ready`) pierde su objeto.

**8. Código demostrablemente inalcanzable.** `isV3State` (`src/storage/state.mjs:84-86`) sin importadores; `assertInitiativeRegistered` (`:389-405`) sin importadores de producción; las ramas de lectura prehistórica `findLegacyNode` (`src/cli/commands/show.mjs:7-12`) y `compatibleNode` (`src/plugins/query.mjs:270-283`), inalcanzables porque `readState` lanza antes para `version: 1`; y `CLI_EXIT_CODES`/`CLI_ERROR_CODES` (`src/contracts/errors.mjs:5-10`) sin importadores.

## Estado de partida

La suite core está **verde** (1.645 tests, 0 fallos, ~66 s medidos en esta rama) y el checkout está limpio: el trabajo de otra sesión que estaba sin commitear ya aterrizó (`e0784ac`), y el único archivo sin trackear es este RFC. El árbol de tests es un **blanco móvil**: al empezar la redacción el runner descubría 159 archivos core y en la ronda 3 descubre 188, por los splits de ADR-034/035 ya integrados. Ninguna cifra de inventario de tests puede tomarse como estable: ADR-039 produce su propio inventario reproducible al crear las tasks.

## Propuesta

**P1 — Todo en 1, y un solo esquema aceptado.** El esquema canónico pasa a `version: 1` en disco y es el único aceptado en lectura y escritura. Se elimina: `migrateState`, la aceptación de 2/3/4, `isV2State`/`isV3State`, el caso especial de `assertStateVersion`, `assertLegacyWriteAllowed`, la escritura v4-only de `writeState`, y la lane de ledger para fuentes legacy (`src/storage/ledger/migration.mjs` entero, `SOURCE_VERSIONS`, y los downgrades v5→v4 de validación de `recovery.mjs:121-146` y `replace.mjs:39-51`, que son proyecciones temporales antes de re-fencear, no auto-migraciones). Los guards discriminan por **forma** además de por número, para separar el v1 prehistórico (`tasks`/`decisions`/`gotchas`) del canónico (`nodes`/`edges`/`initiatives`). En la misma pasada, y por la misma razón (`no quiero v2 ni nada`): `TRANSFER_PAYLOAD_VERSION` pasa de 4 a 1 — cliente y servidor viajan en el mismo release, así que el cambio de campo wire es seguro dentro del big bang —, `PLUGIN_API_VERSION` pasa de 3 a 1 y la versión del core API expuesta a plugins pasa de 2 a 1, con sus fixtures y descriptores actualizados.

**P2 — Los dos seams de bootstrap dejan de depender de la lane legacy.** `init` obtiene su estado fenced y su `revision-ledger.json` en la misma operación bloqueada, usando el bootstrap fenced existente bajo su lock activo, y el bootstrap implícito de `initiative.create` conserva un camino canónico. Se preservan `bootstrap_pending`, el staging, los fingerprints y la reanudación tras crash: escrituras separadas no son una transacción recuperable.

**P3 — Importador obligatorio, pero el camino crítico no es el que parecía.** Es la pieza que hace segura la renumeración. Corre bajo lock, es resumible tras crash y cubre las cuatro formas en disco:

| Forma en disco | Proyectos | Nodos | Tratamiento |
|---|---|---|---|
| `1` prehistórico (`tasks`/`decisions`/`gotchas`) | 5 | 0 | Reconocer la forma por estructura y escribir un estado canónico vacío. Sin conversión semántica: no hay datos |
| `2` y `3` | 29 | 113 | Normalización mecánica a las colecciones canónicas, sin ledger inicial |
| `4` sin ledger | 4 | 146 | Migración al esquema canónico y fence inicial |
| `5` fenced | 2 | 767 | Cambio de número conservando `fence_generation`, high-water y CAS, con revisión monotónica y registro en el log. **Es el camino crítico**: son los dos proyectos activos |

Requisitos operativos que el review marcó como bloqueantes y que el importador debe cumplir: opera por proyecto (`--project`) y en barrido sobre `CLIMIER_HOME` con preview; conserva el ledger de los proyectos fenced; define qué hace con `migration_pending` del protocolo viejo; deja un respaldo completo del directorio del proyecto (estado **y** ledger, no solo `tasks.json`) antes de escribir; y puede reanudarse sin dejar el proyecto inutilizable. **Orden operativo obligatorio:** primero se publica/enlaza el binario nuevo, después se detiene todo escritor (workers, UI, control plane) y recién entonces se importan los proyectos. Un binario previo al corte que lea un estado ya migrado lo interpreta como prehistórico y sugiere `init --force`, que borra datos: por eso ningún binario viejo puede tocar un proyecto migrado, y eso queda escrito en las notas del release y en el runbook. El importador es una herramienta de una sola vez: se retira cuando el parque local esté migrado y no queden formas previas en disco.

**P4 — Superficie CLI sin acomodos legacy.** Se retiran los acomodos que existen solo por historia: los filtros aceptados e ignorados de `take` (`--initiative`, `--domain`, `--tag`, en `src/cli/commands/take.mjs:13`), el `--as` aceptado e ignorado de `install`/`uninstall`, los resets históricos de `resolve` (`src/cli/commands/resolve.mjs:16-36`), el `legacy_patch` sin tipar de `update` (`src/cli/commands/update.mjs:168-200`), el camino sin revisión de `add-note` (`src/cli/commands/add-note.mjs:61-90`, hoy sin ningún test, y cuya única razón de ser eran las fixtures viejas que también desaparecen), los campos de log `task`/`decision`/`gotcha` de `history`/`log` (`src/cli/commands/history.mjs:6-7,15`), el envelope de string histórico para unknown flags (`src/cli/dispatch.mjs:310-316`) y el parsing histórico de `--force init` (`:19-21`). Los flags retirados y su reemplazo se documentan en las notas del release, sin alias.

**P5 — Suite de tests del baseline.** Tres movimientos, en este orden y con owners serializados: (a) borrar los tests que solo existen para la lane eliminada (aceptación de migración, rechazo de v1 prehistórico, lápidas de la superficie v1 muerta), conservando un test único de "versión desconocida rechazada" en lectura y escritura; (b) llevar la fixture compartida y las fixtures por suite al esquema canónico; (c) renombrar los 22 archivos de era y borrar los 39 flags inertes. Y aparte, como última slice y con precondición de `git status` limpio sobre la lista exacta de paths: **borrar la suite UI completa** (14 tests trackeados, el andamiaje de JSX/overview), el script `test:ui`, la exclusión por prefijo del runner core y el loader exclusivo `test/jsx-loader.mjs`.

**P6 — Docs y artefactos de agentes.** Alinear `AGENTS.md`, `README.md`, `docs/reference.md` y `CLIMIER-CHEATSHEET.md` al esquema y la superficie reales (hoy dicen v2/v3 y describen un `src/` que no existe), y eliminar el contrato de lint de docs que pinnea texto viejo (`test/v2-docs.test.mjs:11` exige el literal `"version: 3"`). Elegir una copia canónica de los prompts de agentes y del skill de climier y borrar las otras. Sacar del árbol los planes de ejecución ya cumplidos (`docs/plans/*.md`, 6 archivos, ~3.900 líneas) y `.evidence/`; conservar `.decisions/*.rfc.md` y `.adrs/` como archivo de spec, porque son la trazabilidad del pipeline.

**P7 — Listo para publicar.** Cerrar el ciclo de producto, no solo el de código: CI que corra también lint y una verificación de que no queden referencias a superficies retiradas (`.github/workflows/ci.yml` hoy corre `npm test` y `pack:check`); `npm pack` verificado end-to-end después del corte; `prepublishOnly` con las verificaciones; tag `v1.0.0` y sección de release en `CHANGELOG.md` que explique el corte y la guía de import; runbook del servidor remoto actualizado al esquema v1 (`docs/remote-server.md`); y la recuperación de lock obsoleto revisada y documentada, que hoy es la "ceiling" conocida del diseño (los locks obsoletos no se limpian solos).

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| A — No renumerar: borrar la lane legacy y conservar el número en disco | Cero riesgo sobre los estados vivos; el valor del corte (borrar la lane, alinear tests y docs) se consigue igual | Deja el proyecto con un contador sin linaje y con "v1" usado a la vez para el baseline y para el esquema prehistórico; no responde a `no quiero v2 ni nada`; mantiene la discriminación por número que ya causó el bloqueo de los 5 estados ilegibles |
| B — Renumerar solo el esquema de estado | Un solo número en disco y en docs | Deja los otros números vivos (payload de transferencia en 4, API de plugins en 3, core API en 2) y obliga a una segunda ronda de rompimiento después; parte en dos un corte que se quiere de una vez |
| **C — Big bang: todo en 1, sin compatibilidad, con importador obligatorio (adoptada)** | Un solo número en todas las capas; el corte es además la primera publicación real (nada se publicó nunca, así que no hay consumidor externo que romper); resuelve los 5 estados hoy ilegibles; deja el árbol listo para prod de una vez | Es el corte más grande: el importador es obligatorio y no puede fallar, hay una ventana operativa en la que ningún binario viejo debe tocar un proyecto migrado, y la suite UI pierde verificación (ver riesgos) |

Los revisores recomendaron A en las rondas 1 y 2 y sus bloqueos se aceptan íntegros como requisitos: el importador consciente del ledger (P3), la cobertura de los dos seams de bootstrap (P2), el orden de clientes que comparten `CLIMIER_HOME` (P3), y la precondición objetiva para la slice UI (P5). La diferencia es que el dueño decide asumir el riesgo del rompimiento a cambio de no arrastrar números ni compatibilidad, y el dato de que nada se publicó nunca reduce ese riesgo al parque local, que el importador cubre.

## Alcance

**Dentro:**
- Aceptación de versiones del estado: constantes, `migrateState`, guards de lectura y escritura, y la sonda de versión duplicada (`src/kernel/mutation/execute/shared.mjs:298-320`).
- Los dos seams de bootstrap (P2): `init` obtiene ledger sin depender de la lane legacy, y el bootstrap implícito de `initiative.create` tiene camino canónico.
- Importador de una sola vez (P3), multi-proyecto, con respaldo y reanudación, y su retiro posterior.
- La lane de ledger para fuentes legacy, y el payload de transferencia renumerado a 1 en cliente y servidor.
- Versión de API de plugins y core API a 1, con descriptores y fixtures.
- Los acomodos legacy de la CLI listados en P4.
- Código inalcanzable y exports sin importadores.
- Tests core: borrados de la lane, fixtures canónicas, renombres de era, y la eliminación de la suite UI con su andamiaje y scripts.
- Documentación, artefactos de agentes y planes cumplidos.
- Cierre de producto: CI, packaging, release, runbook y lock obsoleto.

**Fuera:**
- El protocolo HTTP remoto: `PROTOCOL_VERSION` sigue en `1`, con sus operaciones, envelopes, auth y origin binding (ADR-031). Su número ya es 1 y no cambia.
- El número de `.climier.json` y del ledger: ambos ya son 1.
- La semántica del ledger de revisiones: fence, CAS, commit atómico estado+log, recuperación de corrupción, y el staging/fingerprint/reanudación del bootstrap. Este RFC borra la *migración entre versiones*, no el ledger.
- El subproyecto `ui/` como código (sus dependencias no viajan en el paquete npm: `files` incluye `bin`, `src`, `docs/reference.md`, README, CHANGELOG y LICENSE, nunca `ui/`). Se van sus tests, no su fuente, y el comando queda etiquetado **experimental** con fallo accionable cuando el subproyecto no está instalado (ADR-040 §Decisión 8).
- La compatibilidad del workflow de agentes con el parser del validador (`base_sha`, notas WORKTREE legacy) y los scripts bajo `.agents/skills/*/`.
- Rediseño funcional: no se renombran comandos ni operaciones más allá de retirar acomodos.

## Riesgos y open questions

- **El importador es la pieza que no puede fallar.** Cubre 40 estados con 1.021 nodos y 7.941 entradas de log, incluido un proyecto de 500 nodos, y cuatro formas distintas (una de ellas nunca migrada por el código). → Mitigación: respaldo completo del directorio por proyecto antes de escribir; verificación de idempotencia (correrlo dos veces no cambia el resultado); prueba de reanudación tras crash a mitad de proyecto; y una prueba de volumen sobre una copia del proyecto de 500 nodos.
- **Ventana operativa con binarios viejos.** Un binario previo al corte lee un estado migrado como prehistórico y sugiere `init --force`, que borra datos. Esto incluye el control plane global (`~/climier-control`) y la UI, que comparten `CLIMIER_HOME`. → Mitigación: el orden de P3 (publicar/enlazar primero, detener escritores después, importar al final) es obligatorio y va en las notas del release y en el runbook; el respaldo por proyecto es la red de seguridad.
- **La suite UI queda sin verificación mientras su fuente siga en el árbol.** `climier ui` sigue existiendo y `ui/server` lee el estado, pero después de este corte nadie prueba ni el comando ni el servidor de UI; además ADR-034/035 la mencionan y `test/package.test.mjs` no la cubre. → Resuelto por el dueño en la ronda 4: `climier ui` **entra al producto como experimental** —va a seguir cambiando—, se etiqueta experimental en el help, `README.md` y `docs/reference.md`, y el artefacto publicado debe fallar con un error accionable cuando faltan el subproyecto o sus dependencias, en vez del stack de resolución de módulos de hoy (ADR-040 §Decisión 8). La refactorización futura de la UI arranca sin suite, y eso queda anotado.
- **Discriminar la forma prehistórica sin ambigüedad.** Después del corte, `version: 1` es el esquema canónico y a la vez el número del esquema prehistórico muerto; los guards hoy son numéricos. → Mitigación: la detección pasa a ser estructural (un estado con `tasks`/`decisions`/`gotchas` y sin `nodes` es prehistórico) y el error apunta al importador, nunca a `init --force`. Los 5 archivos prehistóricos reales están vacíos, así que el caso no esconde datos.
- **Pérdida de cobertura de forward-compat.** Varios tests que se borran también verifican que una versión desconocida o futura **no** se acepte en silencio. → Mitigación: conservar un test único de "versión desconocida rechazada" en lectura y escritura.
- **Volumen y riesgo de duplicar u omitir tests al mover.** 57 de 188 archivos tocan la lane y la fixture compartida tiene 30 llamadas en 6 suites. → Mitigación: ADR-034 exige igualdad exacta del multiconjunto de nombres de `test()` al mover o partir, pero no contabiliza borrados intencionales. ADR-039 produce inventario reproducible por path y nombre, allowlist explícita de borrados, y un único owner para el contrato de fixtures de `test/helpers.ts`.
- **Orden y colisión de paths entre piezas.** `src/storage/state.mjs` lo tocan P1, P2, P3 y P6; `src/kernel/mutation/execute/provider.mjs` lo tocan P2 y P6; `init` sin estado cae hoy en `writeState` (`src/kernel/mutation/execute/state.mjs`). → Mitigación sugerida por el review de ejecución: serializar owners en el orden P2 → P3 → P1 → P6, escribir primero las regresiones de P2 en `test/init.test.mjs` y `test/kernel/mutation/persistence-recovery.test.mjs`, mantener las pruebas de crash y reanudación de `test/storage-ledger.test.mjs`, y verificar después `restore` y transfer con `test/kernel-state-operations.test.mjs` y `test/kernel-transfer.test.mjs`.
- **Retirar acomodos rompe scripts de otros checkouts.** `take --tag` y `install --as` hoy se aceptan en silencio. → Mitigación: inventariar los scripts y skills del repo antes de retirarlos y actualizarlos en la misma task.
- **Pregunta abierta (resuelta en la ronda 4):** ¿la fuente de `ui/` y el comando `climier ui` también salen en esta pasada, o quedan marcados como no verificados hasta la refactorización futura? El dueño decidió que ni una cosa ni la otra: ambos se quedan, el comando se etiqueta **experimental** y el artefacto publicado falla de forma accionable cuando el subproyecto no está instalado (ADR-040 §Decisión 8).
- **Pregunta abierta:** el nombre de era `v2` fuera de los nombres de test — la iniciativa `v2` del DAG y su backlog (por ejemplo `P1.T2` "Soportar migraciones de metadata") quedan desactualizados con este corte. ¿Se cancelan, se re-scopean o se archivan?
- **Pregunta abierta:** ¿`docs/plans/*.md` y `.evidence/` se borran del árbol (como propone P6) o se conservan como archivo?

## ADRs derivados (se completa al aprobar)

- [ ] ADR-036: esquema de estado v1 y bootstrap con ledger en `init` → `.adrs/036-state-schema-v1.md`
- [ ] ADR-037: importador v1 y orden operativo del corte (multi-proyecto, las cuatro formas en disco, respaldo y reanudación) → `.adrs/037-v1-importer.md`
- [ ] ADR-038: superficie de producto en 1 (CLI sin acomodos, API de plugins y core API en 1, payload de transferencia en 1) → `.adrs/038-product-surface-v1.md`
- [ ] ADR-039: suite de tests del baseline (borrados de la lane, eliminación de la suite UI, fixtures canónicas, renombres de era, lint de docs) → `.adrs/039-test-suite-baseline.md`
- [ ] ADR-040: listo para publicar (CI, packaging, release v1.0.0, runbook, lock obsoleto) → `.adrs/040-production-readiness.md`
