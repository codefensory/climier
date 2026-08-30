# ADR-013: Límites de módulos internos

- Gate: `G-module-layout-adr` · Estado: aprobado
- Fecha: 2026-08-30

## Contexto

El Graph Kernel ya centraliza las mutaciones y los providers contienen gran
parte de la semántica de dominio. Sin embargo, la raíz de `src/` conserva
fachadas y helpers de transición (`v2.mjs`, `v2-add-node.mjs` y `policy.mjs`),
y el host de plugins está repartido entre muchos módulos `plugin-*.mjs`.

La estructura debe expresar la dirección de dependencias y evitar que una
fachada de compatibilidad vuelva a convertirse en una segunda implementación
canónica. Este cambio es organizacional: no modifica el schema v2 ni los
contratos JSON públicos de CLI, plugin API o UI.

## Decision

Adoptar estos límites internos:

```text
src/
  commands/       argv adapters y helpers internos de comandos
  kernel/         mecanismo genérico de mutation/draft/grafo/state operations
  providers/      semántica de dominio pura y policy
  read-model/     proyecciones read-only que combinan kernel y providers
  plugins/        host, runtime, loader, API y adapters de plugins
  storage/        paths, state, lock y log
  contracts/      errors, identidad y contratos transversales
```

Reglas:

1. `commands/` traduce argv a inputs tipados y delega; no contiene semántica
   de dominio ni persistencia.
2. `kernel/` sigue siendo la única frontera de persistencia. No importa
   `commands/`, `read-model/`, UI ni adapters de plugins.
3. `providers/` implementa semántica `prepare/apply` o helpers read-only por
   dominio. No importa storage, CLI, UI ni host de plugins.
4. `read-model/` es la única capa que compone providers de distintos dominios
   para `status`, `context` y consumers UI. No muta ni conoce argv.
5. `plugins/` es el único hogar de módulos del host de plugins. Puede consumir
   kernel/providers/read-model, pero no `commands/`.
6. `storage/` contiene sólo acceso base a filesystem y serialización de estado.
   No conoce providers, commands o plugins.
7. `contracts/` contiene errores e identidad compartidos sin I/O.
8. Se eliminan `src/v2.mjs` y `src/v2-add-node.mjs`; no se dejan shims de
   compatibilidad internos. Los consumers migran antes de borrar cada archivo.
9. Se migra `src/policy.mjs` a `src/providers/policy/` y se elimina el
   re-export ambiguo.
10. No se crea `kernel/node.mjs`: el draft genérico vive en
    `kernel/transaction.mjs`; la semántica de cada node vive en su provider.

La migración conserva ESM y Node stdlib. Los movimientos de módulos no
introducen dependencias runtime ni cambios deliberados de comportamiento.

## Consecuencias

- A favor: dependencias unidireccionales visibles, compatibilidad eliminada,
  y ownership claro para cambios futuros.
- En contra: cambios amplios de imports; se requieren slices pequeños y tests
  de import/dispatch antes de eliminar paths antiguos.
- Riesgo controlado: cada slice debe mover una frontera completa, no dejar
  re-exports temporales ni duplicar implementaciones.

## Plan de implementacion

1. Crear `read-model/`, migrar los consumers de `v2.mjs` y borrar `v2.mjs`.
2. Mover policy a `providers/policy/` y actualizar consumers sin re-export.
3. Mover el helper interno de creación a `commands/internal/` y borrar
   `v2-add-node.mjs`.
4. Reubicar host de plugins bajo `plugins/` y actualizar imports/tests.
5. Reubicar filesystem/state bajo `storage/` y contratos compartidos bajo
   `contracts/`, en dos migraciones seriales por sus imports transversales.
6. Auditar import graph, rutas antiguas, contratos CLI/API y la suite completa.

## Verificacion

- Tests focales del slice y `npm test` después de cada merge.
- `npm run test:concurrent` después de mover kernel/storage.
- `npm run test:ui` cuando cambie un consumer UI o el read-model que consume.
- `git diff --check`.
- Búsqueda estructural: no quedan `v2.mjs`, `v2-add-node.mjs`, `policy.mjs`,
  `plugin-*.mjs` ni módulos state/lock/log/paths en la raíz de `src/`.
- El grafo de imports no contiene dependencias prohibidas de providers hacia
  commands/storage/plugins ni de kernel hacia adapters/UI.
