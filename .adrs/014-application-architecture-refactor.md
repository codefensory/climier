# ADR-014: Application boundary and adapter-oriented module layout

- Gate: `G-architecture-refactor-adr` · Deriva de: ADR-011, ADR-012 y ADR-013 · Estado: aprobado
- Fecha: 2026-08-30

## Contexto

ADR-011 y ADR-012 establecieron un kernel transaccional y providers de
semántica de dominio. ADR-013 normalizó el primer layout, pero el catálogo
nativo de operaciones aún vive bajo `plugins/`, la interfaz de plugins invoca
el kernel directamente, `kernel/mutate.mjs` concentra varias responsabilidades
y los handlers CLI permanecen en `src/commands/`.

El objetivo es hacer visible una dirección arquitectónica única sin alterar el
comportamiento observable: los mismos comandos, envelopes JSON, códigos de
error, lifecycle, estado persistido, semántica de providers y API pública de
plugins. Por instrucción expresa del usuario esta decisión no requiere RFC.

## Decision

La estructura canónica queda:

```text
src/
  application/operations/  composición compartida de operaciones
  execution/               contratos de ejecución y conflictos puros
  kernel/mutation/         pipeline interno de mutación
  kernel/                  transacción, grafo y fachada mutate
  providers/               semántica de dominio pura
  read-model/              proyecciones puras
  storage/                 persistencia
  plugins/                 host/adaptador de plugins
  cli/                     adaptador de línea de comandos
    commands/
```

Las dependencias se dirigen hacia dentro:

```text
CLI / Plugins -> application/operations -> providers -> kernel -> storage
```

`execution/` y `read-model/` son módulos transversales puros. `kernel/`,
`providers/`, `execution/` y `read-model/` no importan adapters (`cli/` o
`plugins/`). `providers/`, `execution/` y `read-model/` tampoco importan
`storage/`. El kernel no conoce application ni adapters.

`application/operations` recibe `{ projectDir, actor, operation, input,
source }`, hace lookup de una operación registrada, selecciona la policy fuera
del lock cuando corresponda, construye el request y delega una sola vez al
kernel. La normalización específica de cada adapter y el mapeo de sus errores
públicos siguen en el adapter. La primera implementación encapsula el camino
existente; no rediseña lifecycle, policy ni el contrato de providers.

El registry genérico y el catálogo de built-ins pertenecen a
`application/operations`. `plugins/core-registry.mjs` se conserva sólo como
fachada de compatibilidad mientras tenga consumidores internos. El adapter
core de plugins consume Application Operations en lugar de poseer registry o
coordinar mutación.

`kernel/mutate.mjs` sigue siendo la API estable `mutate`, pero delega al
coordinador de `kernel/mutation/execute.mjs`. Las extracciones son mecánicas:
validación de request/provider/plan, precondiciones, diff, revisiones,
validación estructural y construcción del log. No cambia el algoritmo ni la
propiedad del lock, write atómico o log.

`contracts/execution-contract.mjs` queda como fachada temporal que reexporta
`execution/index.mjs`; la definición y normalización del contract viven en
`execution/contract.mjs` y la interacción entre contratos en
`execution/conflicts.mjs`.

Los comandos se mueven físicamente a `cli/commands/`, sus imports internos y
los tests se actualizan, y `bin/climier.mjs` consume `cli/dispatch.mjs`. No se
mantienen shims `src/commands/*` después de que todos los consumidores internos
hayan migrado. `contracts/agent.mjs` se divide o se mueve a `cli/actor.mjs`
únicamente en la medida en que sea resolución propia de argv/entorno CLI.

Los comentarios se limpian sólo cuando son arqueología de tasks/planes. Los
invariants y referencias ADR que expliquen una decisión vigente se conservan.

## Consecuencias

- A favor: la entrada compartida de operaciones deja de ser propiedad del host
  de plugins, las fronteras se leen desde el árbol y reglas de import evitan
  regresiones.
- A favor: `mutate` conserva una fachada estable mientras su implementación se
  vuelve auditable como pipeline.
- Coste: varios movimientos de imports y tests; se ejecutan en slices
  pequeños, seriales donde comparten paths.
- Riesgo: una extracción puramente mecánica puede cambiar accidentalmente
  timing de validación, orden de log o envelopes. Cada slice usa TDD y los
  tests actuales de mutación/CLI/plugin como contrato.

## Plan de implementacion

1. Crear el boundary `application/operations` y su API mínima de ejecución.
2. Extraer el registry genérico y el catálogo built-in desde `plugins/`; migrar
   el adapter core de plugins a la API compartida.
3. Descomponer `kernel/mutate.mjs` por responsabilidad y dejar su fachada.
4. Promover execution contract y separar detección de conflictos.
5. Mover dispatch, actor y todos los commands al namespace `cli/` una vez que
   Application Operations esté estable.
6. Limpiar comentarios históricos estrictamente obsoletos.
7. Actualizar AGENTS y agregar tests stdlib de direction/boundary imports.

El DAG ejecutable de estas piezas es `T-architecture-*` en la iniciativa
`architecture-refactor`. El primer tramo es serial (application, registry,
built-ins y adapter); mutation, execution y auditoría histórica se paralelizan
después del adapter; la reubicación CLI espera application y mutation; la
documentación y los boundary tests cierran sobre el árbol final.

## Onboarding breve para crear tasks

- [x] No hace falta: el plan del usuario, los ADR-011/012/013 y el mapa actual
  de imports identifican un objetivo, paths, restricciones, dependencias y
  comandos de verificación para cada slice.

## Verificacion

Para cada task: primero un test rojo representativo, luego los tests focales
indicados y `git diff --check`. Toda mutación o movimiento de contrato ejecuta
`npm test`; cambios que afectan plugins incluyen los tests de adapter/registry;
la mudanza CLI incluye `test/cli-dispatch.test.mjs` y tests de comandos.

Al cierre: `npm test`, `npm run test:concurrent`, `npm run test:ui` si el
movimiento cambia sus imports, y los boundary tests versionados. Se comprueba
que no queden imports de producción hacia `src/commands/`, que
`kernel/mutate.mjs` sea una fachada mínima y que CLI y plugin API conserven sus
envelopes, códigos y operaciones soportadas.
