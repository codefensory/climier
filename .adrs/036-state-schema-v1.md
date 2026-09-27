# ADR-036: esquema de estado v1 y bootstrap con ledger en `init`

- Gate: `G-v1-baseline-adr-036` · Deriva de: `G-v1-baseline-rfc` · Estado: borrador
- Fecha: 2026-09-27

## Contexto

El esquema en disco hoy tiene cuatro números vivos (`CURRENT_STATE_VERSION = 4`, `FENCED_STATE_VERSION = 5`, `LEGACY_STATE_VERSION = 2`, `PREVIOUS_STATE_VERSION = 3` en `src/storage/state.mjs:52-55`) y el arranque de un proyecto nuevo depende de la lane de migración de los esquemas 2, 3 y 4 en dos seams distintos: `init` escribe un `version: 4` sin ledger y la operación siguiente lo fenced a 5 vía `readFencedStateUnderLock` → `bootstrapLocked`/`prepareMigration`; y el bootstrap implícito de `initiative.create` degrada el estado a 4 dentro de `persistMutation` para poder entrar al mismo protocolo. El RFC aprobado (`.decisions/G-v1-baseline-rfc.md`, opción C) decide que el esquema canónico pase a `version: 1` y que la compatibilidad desaparezca. Este ADR fija esa decisión en el almacenamiento y en el arranque. El parque de estados vivos no tiene que sostener nada raro: los cinco archivos con forma prehistórica están **vacíos**, y los dos proyectos con volumen (505 y 262 nodos) ya están fenced.

## Decisión

1. **Un solo esquema aceptado: `STATE_SCHEMA_VERSION = 1`**, en lectura y escritura. Cualquier otro número es un error explícito.
2. **Todo estado canónico es fenced.** Un estado válido tiene `version: 1` y un `fence_generation` entero, con su `revision-ledger.json` al lado. No existe un estado canónico sin ledger.
3. **La clasificación de formas es estructural y vive en un único helper compartido.** Se reemplazan los guards numéricos de `src/storage/state.mjs` y la sonda duplicada de `src/kernel/mutation/execute/shared.mjs:298-320` por un solo clasificador, con esta precedencia exacta:

| Orden | Condición sobre el JSON | Resultado |
|---|---|---|
| 1 | No parsea o no es un objeto | Error de formato |
| 2 | Tiene `tasks`/`decisions`/`gotchas` y no tiene `nodes` | `PRE_RELEASE_STATE_UNSUPPORTED` (renombra `STATE_V1_UNSUPPORTED`), con mensaje que apunta a `climier migrate` (ADR-037) y **nunca** a `init --force` |
| 3 | `version` no es entero, o es mayor que 1 | `CLIMIER_INCOMPATIBLE_VERSION` |
| 4 | `version === 1` y falta `nodes`, `edges`, `initiatives` o `log` | Estado incompleto: error explícito, nunca aceptación parcial |
| 5 | `version === 1`, `fence_generation` entero y existe `revision-ledger.json` | Canónico |
| 6 | `version === 1` sin `fence_generation` o sin ledger | Estado no canónico (no puede existir): error explícito que apunta al importador |

Un `version: 2` o superior falla por el orden 3. La regla de que el orden 2 se evalúe antes que el 3 es lo que separa el v1 prehistórico del canónico sin depender del número.
4. **`init` obtiene estado y ledger en la misma operación bloqueada.** Se elimina el estado intermedio v4 sin ledger: `init` usa el bootstrap fenced existente bajo su lock activo.
5. **El bootstrap implícito de `initiative.create` usa el mismo camino canónico.** Se preservan `bootstrap_pending`, el staging, los fingerprints y la reanudación tras crash: escrituras separadas no son una transacción recuperable.
6. **Se retira la lane de migración entre versiones**: `migrateState`, `isV2State`, `isV3State`, el caso especial de `assertStateVersion` que acepta el literal `2` para un estado v4, `src/storage/ledger/migration.mjs` completo, `SOURCE_VERSIONS`, los downgrades v5→v4 de validación de `src/storage/ledger/recovery.mjs:121-146` y `src/storage/ledger/replace.mjs:39-51`, y la sonda de versión duplicada de `src/kernel/mutation/execute/shared.mjs:298-320`.
7. **Ninguna API de escritura puede dejar un estado sin ledger.** No alcanza con retirar `writeState`: `updateState` (`src/storage/state.mjs:248-263`) persiste fuera del ledger y `src/storage/log.mjs:76-81` lo invoca, así que la ruta de `append` del log también se retira como escritor directo y pasa por el commit del ledger. El fallback de `executeStateMutation` (`src/kernel/mutation/execute/state.mjs:137-143`) se elimina: `init` sin estado usa el bootstrap fenced, y `init --force` o `restore` sobre un estado fenced corrupto no pueden caer a una escritura directa. Las fixtures de test que necesitan escribir estados crudos se resuelven en ADR-039, restringidas a los tests que prueban el importador y los guards.
8. **`writeState` deja de ser API pública de escritura.** El único camino de escritura de estado es el commit del ledger.
9. **Constantes nombradas por dominio**, para que cuatro "versiones" no se lean igual: `STATE_SCHEMA_VERSION`, `LEDGER_VERSION`, `PROJECT_META_VERSION` y `TRANSFER_PAYLOAD_VERSION` (la última se decide en ADR-038). La condición "fenced" se expone en un único helper y deja de estar duplicada como literal `5` en `provider.mjs`, `batch.mjs` y `state-operations.mjs`. **Mientras la lane legacy siga viva (hasta la pieza 4), ese helper acepta dos marcadores**: el canónico (`STATE_SCHEMA_VERSION = 1`) y el fenced legacy (`5`); el retiro de la lane lo colapsa a canónico-solo. `assertFencedState` (`src/storage/ledger/stages.mjs:13-23`) es el punto exacto donde eso se decide, y sin ese cambio un estado recién bootstrapeado no puede confirmarse ni recuperarse: es prerequisito de la pieza 2, no del retiro de la lane.
10. **`restore` y transfer pasan por el camino fenced, y solo aceptan v1.** Instalar un snapshot en un proyecto debe producir estado canónico **y** ledger consistente, usando el protocolo de reemplazo del ledger que ya existe, en lugar de `writeState`. Decisión del dueño: `restore` acepta **solo snapshots canónicos** (`version: 1` con ledger consistente); un snapshot histórico 2/3/4/5 se rechaza con un error que nombra el path del snapshot y apunta a `climier migrate` (ADR-037). Instalar un snapshot es reemplazar el estado vivo, no importar un esquema viejo: aceptarlo reintroduciría la conversión de formas que este corte elimina, y con ella la lane que se está borrando. El pre-snapshot que `restore` toma antes de escribir es canónico, como cualquier estado que escriba el binario.

## Consecuencias

- A favor: una sola forma en disco; el arranque deja de depender de una lane de migración; los guards dejan de ser numéricos y ambiguos; `init` pasa a ser atómico de verdad (estado y ledger juntos); desaparecen los literales de versión dispersos.
- A favor: se borra código con superficie grande y sin dueño claro (`ledger/migration.mjs`, la sonda duplicada, dos exports inalcanzables).
- En contra / deuda: el importador de ADR-037 es **prerequisito** para cualquier estado existente, incluidos los dos proyectos activos; `restore` y transfer cambian de camino y necesitan cobertura nueva; el número 1 pasa a designar el esquema canónico y el prehistórico, y eso se sostiene solo con detección estructural (si alguien vuelve a un guard numérico, se rompe en silencio).
- En contra / deuda: los fixtures de test que hoy escriben estados crudos pierden su contrato y hay que redefinirlo (ADR-039), lo que hace que este ADR y el 039 se toquen en `test/helpers.mjs`.

## Plan de implementación

Cada pieza es candidata a task. **El orden es obligatorio**: el bootstrap canónico va primero y los guards estructurales al final, porque un guard que exige `version: 1` antes de que exista el camino de arranque y el importador deja el árbol en un estado que nadie puede leer.

1. **Regresiones de arranque canónico (primero, TDD)** — archivos: `test/init.test.mjs`, `test/kernel/mutation/persistence-recovery.test.mjs`, `test/storage-ledger.test.mjs`. Escribir los tests que fallan: `init` deja `version: 1` + `fence_generation` + ledger sin ninguna mutación previa; la creación implícita de iniciativa hace bootstrap canónico; el crash a mitad de bootstrap se reanuda.
2. **Bootstrap canónico en los dos seams** — archivos: `src/kernel/mutation/execute/state.mjs`, `src/kernel/mutation/execute/provider.mjs`, `src/storage/ledger/bootstrap.mjs`, **y el borde de lectura/staging fenced**: `src/storage/ledger/stages.mjs` (`assertFencedState`) y `src/storage/ledger.mjs` si hace falta para que la aceptación dual llegue al lector. `init` y el bootstrap implícito sin estado intermedio, preservando staging, fingerprint y reanudación. Sin la aceptación dual del marcador (§Decisión 9) esta pieza no cierra: `init` dejaría artefactos que `readFencedStateUnderLock` rechaza. Este archivo queda bajo la ventana de esta task; las piezas 4 y el importador fenced lo vuelven a tocar después, en orden.
3. **Escritura sin ledger fuera de circulación** — archivos: `src/storage/state.mjs` (`writeState` y `updateState`), `src/storage/log.mjs` (la ruta de `append` deja de escribir directo y pasa por el commit del ledger), `src/kernel/mutation/execute/state.mjs` (se elimina el fallback de escritura directa).
4. **Retiro de la lane de migración y de sus consumidores colgados** — archivos: borrar `src/storage/ledger/migration.mjs`; `src/storage/ledger.mjs`, `src/storage/ledger/recovery.mjs`, `src/storage/ledger/replace.mjs`, `src/storage/ledger/commit.mjs:11` (importa `finishPendingMigration`), `src/storage/ledger/stages.mjs:4` (importa `FENCED_STATE_VERSION`), `src/kernel/mutation/execute/shared.mjs`. Colapsar `SOURCE_VERSIONS` y las proyecciones de validación.
5. **Guard estructural único (P1)** — archivos: `src/storage/state.mjs` (el clasificador de la tabla), `src/kernel/mutation/execute/shared.mjs` (se borra la sonda numérica duplicada), y los consumidores que hoy esperan los números viejos: `src/cli/commands/context.mjs:54`, `src/cli/commands/search.mjs:9`, `src/plugins/query.mjs`, `src/plugins/dispatch.mjs`. **Depende de ADR-037**: el orden 2 de la tabla apunta a `climier migrate`, así que el comando tiene que existir o el mensaje manda a la nada.
6. **`restore` y transfer por el camino fenced** — archivos: `src/kernel/state-operations.mjs`, `src/storage/transfer.mjs`. Snapshot instalado como estado canónico + ledger consistente, y **rechazo explícito de snapshots históricos 2/3/4/5** apuntando al importador (decisión del dueño: solo v1). La cobertura incluye el rechazo, no solo el camino feliz.
7. **Retiro de código inalcanzable y de exports sin consumidor** — archivos: `src/cli/commands/show.mjs`, `src/plugins/query.mjs`, `src/contracts/errors.mjs`. Ramas prehistóricas y códigos sin importadores.
8. **Limpieza de literales y helper único de fence** — archivos: `src/kernel/mutation/execute/provider.mjs`, `src/kernel/mutation/execute/batch.mjs`, `src/kernel/state-operations.mjs`. Sin `5` disperso.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — `restore` acepta solo v1 (decisión del dueño, §Decisión 10). El nombre final del código de error y el texto del mensaje que apunta al importador los fija la task que introduce el clasificador, con este contenido mínimo: path del archivo, forma detectada y `climier migrate` como salida. No queda ninguna pregunta abierta que impida crear las tasks.
- [ ] No hace falta — por qué el ADR ya permite crear una task clara.

## Verificación

- `npm test` verde, sin la lane legacy y con los tests de arranque nuevos.
- Smoke: `climier --project <tmp> init` deja `version: 1`, `fence_generation` y `revision-ledger.json` sin ninguna mutación previa; la primera mutación no crea `migration_pending`.
- Un archivo con `tasks`/`decisions`/`gotchas` falla con el código nuevo y el mensaje menciona `climier migrate`, no `init --force`.
- Un archivo `version: 6` sigue rechazándose como incompatible.
- `restore` de un snapshot sobre un proyecto fenced deja estado canónico y ledger consistente, y una mutación posterior funciona.
- `restore` de un snapshot con `version: 2`, `3`, `4` o `5` falla con el código nuevo, nombra el path del snapshot en `details` y el mensaje menciona `climier migrate`; el estado vivo y el ledger quedan intactos.
- `grep -rn "LEGACY_STATE_VERSION\|PREVIOUS_STATE_VERSION\|CURRENT_STATE_VERSION\|FENCED_STATE_VERSION" src/` no devuelve resultados.
- `grep -rn "readFencedStateUnderLock\|bootstrapFencedStateUnderLock" src/storage/ledger/migration.mjs` falla porque el archivo ya no existe.
