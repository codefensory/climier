# ADR-037: importador v1 y orden operativo del corte

- Gate: `G-v1-baseline-adr-037` · Deriva de: `G-v1-baseline-rfc` · Estado: borrador
- Fecha: 2026-09-27

## Contexto

El RFC aprobado (`.decisions/G-v1-baseline-rfc.md`) renumeró el esquema canónico a 1 y retiró la compatibilidad (ADR-036). Los estados que existen hoy en el `CLIMIER_HOME` no están en ese esquema y el binario nuevo no los va a leer. La medición real del parque, hecha durante el RFC:

| Esquema en disco | Proyectos | Nodos | Entradas de log |
|---|---|---|---|
| `1` prehistórico (`tasks`/`decisions`/`gotchas`) | 5 | 0 | 0 |
| `2` | 29 | 113 | 778 |
| `4` sin ledger | 4 | 146 | 1.421 |
| `5` fenced | 2 | 767 | 5.751 |

Dos hechos ordenan el trabajo. Los cinco estados prehistóricos están vacíos, así que no hay conversión semántica que hacer. Y los dos proyectos que concentran el 75% de los nodos y el 72% del log ya están fenced y al día: el camino crítico es preservar ledger, high-water y CAS, no recomponer formas viejas. Además, un binario previo a este corte interpreta un estado `version: 1` como el esquema prehistórico y sugiere `init --force`, que borra datos.

## Decisión

1. **Comando temporal `climier migrate`.** Con `--project <dir>` opera un proyecto; con `--all` barre los proyectos del `CLIMIER_HOME`; `--dry-run` funciona en ambos modos y no escribe nada (y reporta los 46 directorios, distinguiendo los 40 con estado de los 6 que no lo tienen). **Decisión del dueño: `migrate` no lleva `--as`.** Es un camino de mantenimiento —la excepción que el repo ya contempla como setup/recovery—, así que no tiene flag de actor ni pasa por la autorización de plugins: se invoca pelado. Para que el log quede trazable sin inventar autorización, la entrada registra un **actor de sistema fijo** (`migrate`), que no se confunde con un agente. El resto del contrato de mutación no cambia: lock por proyecto y commit atómico de estado más log, nunca una escritura paralela.
2. **El lock se adquiere por `project_id`, no por directorio.** Hoy `withLock(projectDir)` deriva el estado y el lock del `.climier.json` o de un hash del path resuelto (`src/storage/lock.mjs:63-82,135-149`, `src/storage/state.mjs:25-35`): pasarle el directorio global de `CLIMIER_HOME` no lockea el `tasks.json` real del proyecto que se está barriendo, y podría lockear o crear otro store. El barrido necesita una API de storage/lock que resuelva el estado por `project_id` —sin reimplementar el lock— y una prueba de contención contra un escritor activo.
3. **Cubre las cuatro formas en disco**, cada una con su tratamiento:

| Forma | Tratamiento |
|---|---|
| `1` prehistórico | Reconocer por estructura (`tasks`/`decisions`/`gotchas` sin `nodes`) y escribir un estado canónico vacío. Sin conversión semántica |
| `2` y `3` | Normalización a las colecciones canónicas, fence inicial y **normalización de `resolution_mode`** en los gates que no lo declaren (hoy el default lo inyectaba el adaptador de `resolve`, que ADR-038 retira) |
| `4` sin ledger | Migración al esquema canónico y fence inicial |
| `5` fenced | Cambio de número usando el protocolo del ledger, conservando `fence_generation`, high-water y CAS, con revisión monotónica y registro en el log |

4. **El camino fenced es un commit de solo esquema, no un `replace`.** El `replace` normal **no** sirve para esto: sube el high-water a `max+1` y rebasa la revisión de todos los nodos (`src/storage/ledger/replace.mjs:54-70`), lo que invalida los tokens CAS anteriores, y registra `last_replace` en el ledger en lugar de una entrada en `state.log`. La transición v5→1 se hace como una operación del ledger que: cambia solo el número de esquema, **conserva la revisión de cada nodo** (los tokens CAS siguen valiendo), preserva `fence_generation`, high-water y contadores, avanza la revisión de estado de forma monotónica y deja una entrada en `state.log`. La validación del origen se hace por estructura (v5 con su ledger), no contra la constante global del marcador: `assertFencedState` (`src/storage/ledger/stages.mjs:13-23`) exige hoy el marcador vigente, así que un origen v5 sería rechazado justo cuando ADR-036 cambia ese marcador a 1.
5. **Protocolo de importación con stage y pending, propio y recuperable.** Las formas 2/3/4 y la prehistórica no pueden reusar el camino tal cual: `bootstrapFencedStateUnderLock` es create-only y rechaza un `tasks.json` existente (`src/storage/ledger/bootstrap.mjs:224-246`), y el único camino que hoy migra un estado existente es `bootstrapLocked`/`prepareMigration` (`:302-348`), que depende del módulo que ADR-036 elimina. El importador generaliza la maquinaria de stage, fingerprint y `bootstrap_pending` que ya existe, en lugar de escribir en dos pasos. Política para un `migration_pending` previo del protocolo viejo: el importador lo **detecta y se detiene** en ese proyecto con un error que nombra el pending, porque su estado es ambiguo; ese proyecto se resuelve con el binario anterior antes del corte, o se acepta explícitamente recrearlo.
6. **Respaldo completo antes de escribir.** Copia del directorio del proyecto —`tasks.json`, `revision-ledger.json` y cualquier stage o pending— a `$CLIMIER_HOME/backups/<project_id>/<timestamp ISO>/`. El respaldo vive **fuera de `projects/`** para que ni el barrido ni la resolución de proyectos lo confundan con un proyecto; se conserva hasta que el proyecto pase una verificación de lectura y una mutación, y es la red de seguridad declarada del corte.
7. **Idempotente y reanudable.** Correr `migrate` dos veces sobre un proyecto ya migrado no cambia nada. Un crash a mitad de proyecto no deja el proyecto ilegible: no hay ventana en la que falte el ledger o el estado.
8. **El barrido no aborta por un proyecto.** `--all` reporta por proyecto (forma detectada, versión de origen, nodos, entradas de log, resultado) y sigue; si alguno quedó sin migrar, termina con exit distinto de cero y los nombra.
9. **Orden operativo obligatorio**, en este orden y sin excepción: (a) publicar o enlazar el binario nuevo; (b) detener todo escritor —workers, UI y control plane— que use un binario previo al corte; (c) correr `migrate --all`; (d) verificar lectura y una mutación por proyecto. Ningún binario previo al corte puede tocar un proyecto ya migrado. El paso (c) incluye el proyecto de este mismo repo: es el de mayor volumen y queda migrado en la misma pasada, no en una ventana aparte, porque el paso (b) ya exige que no haya escritores activos.
10. **El comando se retira.** `climier migrate` es herramienta de una sola vez: se elimina en una task de cierre cuando el parque local esté migrado y no queden formas previas en disco. No queda como superficie permanente ni como compatibilidad diferida.
11. **La guía de import va en las notas del release y en el runbook**, incluido el aviso de que un binario viejo sobre un proyecto migrado es destructivo.

## Consecuencias

- A favor: el corte deja de ser riesgoso sobre datos: el parque está medido y el camino crítico son dos proyectos que ya están en el formato moderno.
- A favor: por primera vez los cinco proyectos prehistóricos dejan de estar en un limbo ilegible, y pasan a ser estados canónicos vacíos sin intervención manual.
- En contra / deuda: existe una ventana operativa en la que ningún binario viejo debe escribir; el respaldo por proyecto es la red de seguridad y consume disco.
- En contra / deuda: `climier migrate` es superficie temporal con una task de retiro pendiente; si alguien la olvida, queda un comando sin propósito en el producto.

## Plan de implementación

**Orden de las dependencias.** La detección estructural de la pieza 2 reusa `classifyStateShape` de `src/storage/state.mjs` (ADR-036 §Decisión 3), así que esa slice depende del **clasificador** y no del arranque canónico: es un barrido de solo lectura que no migra nada ni escribe un byte. Las piezas 3 y 4 sí dependen del arranque canónico, porque escriben por el protocolo de stage y commit del ledger (ADR-036 §Plan pieza 2: «el importador fenced los vuelve a tocar después, en orden»). En el DAG eso se refleja como `T-v1-state-classifier → T-v1-migrate-skeleton` y `T-v1-schema-bootstrap → T-v1-migrate-fenced`, con lo que el esqueleto puede correr en paralelo con el bootstrap.

1. **Comando y selección de alcance** — archivos: `src/cli/commands/migrate.mjs` (nuevo), `src/cli/dispatch.mjs` (routing y help), `src/cli/commands/reserved-namespaces.mjs`. `--project`, `--all`, `--dry-run`, la API de lock por `project_id`, y **sin `--as`**: la entrada de log usa el actor de sistema fijo.
2. **Detección de forma y reporte** — archivos: módulo de detección junto a `src/storage/state.mjs`. Clasificación estructural de las cuatro formas y reporte por proyecto sin abortar el barrido.
3. **Camino de formas viejas (2/3/4 y prehistórico)** — archivos: el módulo del importador, `src/storage/ledger/bootstrap.mjs`. Normalización y fence inicial usando el protocolo de stage, fingerprint y pending generalizado, con la política de detenerse ante un `migration_pending` previo.
4. **Camino fenced por commit de solo esquema** — archivos: el módulo del importador, `src/storage/ledger/stages.mjs`, `src/storage/ledger/commit.mjs`, `src/storage/ledger/replace.mjs` (solo si hay que ajustar la validación del origen). Cambio de número que conserva la revisión de cada nodo, `fence_generation` y high-water, con entrada en `state.log`.
5. **Respaldo y reanudación** — archivos: el módulo del importador. Copia previa completa del directorio del proyecto y recuperación ante crash.
6. **Guía de import en el release y el runbook** — archivos: `CHANGELOG.md`, `docs/remote-server.md`, `README.md`. Orden operativo y advertencia sobre binarios previos.
7. **Retiro del comando (task de cierre, bloqueada por las anteriores)** — archivos: `src/cli/commands/migrate.mjs`, `src/cli/dispatch.mjs`. Se ejecuta cuando el parque local esté migrado.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el respaldo vive en `$CLIMIER_HOME/backups/<project_id>/<timestamp ISO>/` (§Decisión 6) y el proyecto de este repo se migra en la misma pasada con los escritores detenidos (§Decisión 9). Sin `--as` (§Decisión 1). No queda ninguna pregunta abierta que impida crear las tasks.
- [ ] No hace falta — por qué el ADR ya permite crear una task clara.

## Verificación

- `climier migrate --all --dry-run` lista los 40 proyectos con su forma detectada y su conteo de nodos, y no modifica ningún archivo (`git status` y hashes de estado sin cambios).
- Sobre una copia del proyecto de 505 nodos: `migrate` termina sin error, el conteo de nodos y de entradas de log se conserva, el estado queda `version: 1` con `fence_generation`, y una mutación posterior (`add-note`) funciona.
- Correr `migrate` dos veces seguidas sobre el mismo proyecto no cambia el estado la segunda vez.
- Interrumpir `migrate` a mitad (SIGKILL) y volver a correrlo deja el proyecto legible y consistente.
- Un proyecto con forma prehistórica termina como estado canónico vacío y legible por `climier status`.
- Un archivo corrupto en el barrido se reporta, no aborta el resto, y el exit code final es distinto de cero nombrando el proyecto afectado.
- El respaldo existe y contiene `tasks.json`, `revision-ledger.json` y cualquier stage o pending de cada proyecto migrado, y los puntos de crash (antes y después de publicar el pending, y antes y después de reemplazar el estado) se ejercitan en las pruebas.
- Un proyecto con `migration_pending` previo del protocolo viejo se detiene con un error que lo nombra, sin migrarlo, y no impide que el resto del barrido continúe.
