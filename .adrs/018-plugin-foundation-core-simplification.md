# ADR-018: Core sin semántica de ejecución y lifecycle sin `task.resolve`

- Gate: `G-plugin-foundation-core-adr` · Deriva de: `G-plugin-foundation-rfc` · Estado: borrador
- Fecha: 2026-08-31

## Contexto

ADR-015/016/017 introdujeron `submitted` y dejaron `task.resolve` como bypass
manual compatible. A la vez, el core interpreta `meta.execution` (`effort`,
`risk`, `owns`, `reads`, `seam`, `checks`) y publica conflictos de ownership en
context. Estas son decisiones y señales de un harness de ejecución, no
invariantes de un DAG/lifecycle genérico.

El plugin futuro necesita que `done` represente aceptación, no una mutación
manual desde `open` o `in_progress`. Esta decisión reemplaza exclusivamente las
secciones de compatibilidad de task resolve de ADR-015 y ADR-016; no cambia el
lifecycle de gates ni el submission workflow de ADR-017.

## Decision

1. Se eliminan `src/execution/**` y `src/contracts/execution-contract.mjs`; el
   core no valida, normaliza, proyecta ni razona sobre `meta.execution`,
   ownership, paths, effort, risk, seam o checks.
2. Los adapters y providers de `task.create`, `task.update` y `add-node` no
   interpretan `meta.execution`. `meta` sólo se conserva como metadata genérica
   si ya se transporta sin semántica. Datos históricos en `meta.execution` se
   preservan como JSON opaco: no se migran, borran ni afectan lecturas.
3. Se elimina `task.resolve` del provider, catálogo Application Operations,
   `api.core`, policy actions, CLI/help y documentación. `resolve` queda como
   verbo exclusivo de gates; sobre una task falla con un código estable de
   estado/tipo, sin modificarla.
4. La única ruta normal a `done` es `open/ready → take → in_progress → submit
   → submitted → accept → done`; `reject` devuelve a `open`. `reopen` y
   `cancel` conservan sus semánticas administrativas ya definidas.
5. Context, query y documentación sólo proyectan lifecycle del core. Se retiran
   `execution_contract`, `ownership_conflicts` y `OWNERSHIP_CONFLICT`.

## Consecuencias

- A favor: `done` sólo resulta de aceptación; core no prescribe cómo un plugin
  planifica ni ejecuta trabajo.
- A favor: los datos históricos quedan recuperables sin crear dos modelos.
- En contra: rompe API/CLI de plugins y scripts que invocaban `task.resolve`;
  la incompatibilidad queda cubierta por la nueva Plugin API versionada.
- En contra: requiere actualizar fixtures, políticas y documentación portable
  en el mismo corte de contrato.

## Plan de implementacion

1. Retirar interpretación de execution y sus proyecciones — archivos:
   `src/execution/**`, `src/contracts/execution-contract.mjs`, task create/update,
   `add-node`, `context`/plugin query y tests de contrato.
2. Retirar `task.resolve` de providers, registry, policy, API y CLI — archivos:
   `src/providers/task/resolve.mjs`, `src/providers/task/index.mjs`,
   `src/application/operations/builtins.mjs`, `src/plugins/core-adapter.mjs`,
   `src/cli/commands/resolve.mjs`, dispatch y tests lifecycle/API.
3. Alinear documentación, skills, agentes, README, cheatsheet, docs y ejemplos
   con `submit → validator → accept/reject`; eliminar instrucciones o contratos
   de ejecución obsoletos.

## Onboarding breve para crear tasks

- [x] Realizado — el retiro de execution toca su propia fachada y tests; el
  retiro de resolve toca lifecycle/registry/CLI; la limpieza documental depende
  de ambos. Se mantienen tres tasks seriales para no editar `query`, dispatch y
  fixtures concurrentemente.

## Verificacion

- Ninguna API pública permite `in_progress → done` ni `open → done` para una
  task; sólo `accept` lo hace desde `submitted`.
- `grep` sobre código core no encuentra `execution_contract`,
  `OWNERSHIP_CONFLICT`, `effort`, `risk`, `seam`, `checks` ni ownership salvo
  referencias históricas de migración explícitas.
- Datos `meta.execution` existentes sobreviven read/write como metadata opaca.
- `npm test` queda verde.
