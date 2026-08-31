# ADR-016: Operaciones y compatibilidad de task submission

- Gate: `G-task-lifecycle-operations-adr` · Deriva de: `G-task-lifecycle-model-adr` · Estado: aprobado
- Fecha: 2026-08-31

## Contexto

ADR-015 define que `submitted` separa la implementación de la aceptación. Las
operaciones canónicas, el registry, la API core de plugins y la CLI deben
expresar la misma transición sin duplicar reglas en adapters.

## Decision

Se agregan tres Application Operations y providers puros:

```text
task.submit  in_progress -> submitted
task.accept  submitted   -> done
task.reject  submitted   -> open
```

Cada provider valida tipo `resolvable/task`, actor e input antes de aplicar un
patch sobre el transaction draft. Ningún provider adquiere locks, persiste ni
construye logs fuera del pipeline kernel.

- `task.submit` requiere el owner actual del claim y una nota de entrega. Su
  resultado no desbloquea nada: `effects.newly_ready` es `[]`.
- `task.accept` requiere una task `submitted`, no exige que el validator difiera
  de `submitted_by`, y calcula `newly_ready` comparando la derivación previa y
  posterior, igual que el `resolve` existente.
- `task.reject` requiere `reason`, vuelve a `open`, limpia metadata de
  submission y registra la razón en el log atómico.

`task.resolve` se conserva con sus inputs, envelopes y transiciones observables
actuales (`open`/`in_progress` a `done`). Es el único bypass manual compatible;
no se modifica para usar `submitted` ni se depreca en esta iniciativa.

Se registran las tres operaciones en
`src/application/operations/builtins.mjs` y se exportan desde
`src/providers/task/index.mjs`. El `core` plugin ya consume el catálogo
canónico, de modo que obtiene las operaciones por registry sin otro mecanismo.

La CLI añade exactamente:

```bash
climier submit <id> --note "..." --as <actor>
climier accept <id> --as <actor>
climier reject <id> --reason "..." --as <actor>
```

Sus adapters sólo normalizan argv, resuelven actor, llaman
`executeOperation` y mantienen el envelope `{ node, newly_ready }` cuando
aplica. Dispatch, help y namespaces reservados se actualizan juntos.

## Consecuencias

- A favor: CLI y plugin API comparten las mismas validaciones y mutation
  frontier atómica.
- A favor: sólo `accept` puede producir `newly_ready` en el flujo agentic.
- Coste: `resolve` mantiene temporalmente dos caminos hacia `done`.
- Riesgo: los adaptadores podrían divergir en flags/error envelopes; las pruebas
  de CLI, registry y plugin core son obligatorias.

## Plan de implementacion

1. Crear y cubrir `submit`, `accept` y `reject` sobre ADR-015.
2. Alinear `take`, `release`, `cancel` y `reopen` con `submitted`.
3. Registrar/exportar providers y cubrir registry/API core.
4. Añadir adapters CLI y pruebas públicas de dispatch.

## Onboarding breve para crear tasks

- [x] No hace falta: cada provider tiene archivo propio; el ajuste de lifecycle
  existente comparte `test/v2-lifecycle.test.mjs` y se mantiene serial; registry
  y CLI se separan por paths y dependen de los providers terminados.

## Verificacion

Tests de matriz estricta para los tres providers, ownership de `submit`,
`submitted` no claimable/releasable, cancel desde `submitted`, compatibilidad de
`resolve`, registry/API core y comandos reales de CLI. Después de cada cambio
que toca operación compartida: `npm test`.
