# ADR-020: Batch declarativo y atómico del core

- Gate: `G-plugin-foundation-batch-adr` · Deriva de: `G-plugin-foundation-rfc` · Estado: borrador
- Fecha: 2026-08-31

## Contexto

Un replanner debe poder reemplazar una porción del DAG sin dejar estados
intermedios observables. Repetir `api.core.run()` o invocar comandos uno a uno
crea commits, logs, revisiones y ventanas de conflicto independientes. Mantener
un lock mientras ejecuta planificación async arbitraria tampoco es seguro.

ADR-019 entrega un draft validable, operaciones registradas y CAS global; este
ADR compone esas operaciones dentro de una sola mutación sin introducir otro
scheduler ni un runtime de plugin.

## Decision

1. Se agrega una operación pública `core.batch` / `api.core.batch({
   if_state_revision, operations })` y el comando `climier batch --file <json>`
   o `climier batch --stdin`. El documento de entrada contiene sólo
   `if_state_revision` opcional y una lista no vacía de `{ op, input }`. La
   implementación es un executor `kernel/mutation/batch` alcanzado desde la
   única fachada `kernel/mutate`; no abre un segundo lock/frontier ni invoca
   `mutate` de forma reentrante.
2. El batch resuelve operaciones exclusivamente desde el catálogo Application
   Operations built-in. No acepta handlers, funciones, argv anidado, actor o
   pluginId aportados por cada entrada; identidad y policy source son los del
   host/CLI exterior.
3. Bajo un solo lock: se carga snapshot, se comprueba CAS global, se crea un
   draft, y se ejecutan `prepare`/policy/apply de cada operación en orden contra
   un snapshot inmutable construido desde la vista vigente del draft. Al final
   se validan las invariantes de ADR-019, se calcula un único diff, se
   incrementa una vez `state.revision`, se escribe una vez y se agrega un único
   log `core.batch` con resúmenes por operación y redacción segura. El executor
   vive dentro de la frontera kernel/Application Operations; no llama
   `mutate()` ni `api.core.run()` de forma anidada.
4. Si una operación falla, se descarta el draft completo. El error conserva el
   código de dominio y añade `details.operation_index`, `details.op` y, cuando
   exista, el resultado de validación seguro; no hay write, log ni incremento.
5. El éxito devuelve `{ ok:true, revision_before, revision_after, results }`.
   Cada resultado identifica `op`, `result`, `effects` e `idempotent`; no
   expone internals mutables del draft. Un batch compuesto sólo de no-ops no
   persiste y devuelve la misma revisión antes/después.

## Consecuencias

- A favor: una reparación expresa el cambio final, es reintentable con CAS y
  no deja aristas/nodes a medio aplicar.
- A favor: no aparece reentrancia de lock ni un segundo mutation frontier.
- En contra: se debe adaptar el protocolo provider para preparar contra la
  vista del draft, conservando las precondiciones y policy por operación.
- En contra: un log único pierde el formato histórico de un log por comando;
  el payload debe ser auditable sin incluir plugin data ni valores sensibles.

## Plan de implementacion

1. Implementar el executor batch sobre el kernel/transaction y el catálogo,
   incluyendo rollback, CAS, log/diff/revisión global y pruebas de errores —
   archivos: `src/kernel/mutation/**`, Application Operations y tests kernel.
2. Exponer `api.core.batch` sin crear una registry paralela; adaptar los tests
   de fixture y error surface — archivos: `src/plugins/{api,core-adapter}.mjs`.
3. Añadir el adapter CLI `batch` con input estricto por file/stdin, ayuda y
   pruebas shell de éxito/error/atomicidad.

## Onboarding breve para crear tasks

- [x] Realizado — executor kernel y API comparten contratos internos y deben
  terminar antes del adapter CLI. La entrada CLI se mantiene en una task propia
  para preservar el corte kernel/provider/adapter.

## Verificacion

Partiendo de `T1→T2`, el batch `create T3; remove T1→T2; add T1→T3; add T3→T2`
persiste exactamente `T1→T3→T2` con un solo incremento de revisión. Si falla
la última operación, el estado serializado y revisión quedan exactamente como
antes. `npm test` y `npm run test:concurrent` quedan verdes.
