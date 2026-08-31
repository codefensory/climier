# ADR-017: Proyecciones y workflow de validación

- Gate: `G-task-lifecycle-workflow-adr` · Deriva de: `G-task-lifecycle-model-adr` · Estado: aprobado
- Fecha: 2026-08-31

## Contexto

El lifecycle sólo es operativo si los consumidores ven `submitted` sin
clasificarla como trabajo disponible y los agentes portables terminan en el
punto correcto. La UI es read-only, pero contiene listas cerradas de statuses.

## Decision

Las proyecciones públicas reconocen `submitted` como estado persistido
explícito:

- `status` añade `summary.submitted` y `tasks.submitted`; filtros, límites y
  `--all` conservan el comportamiento consistente con `in_progress`.
- `context` devuelve `derived_status: "submitted"` y acciones permitidas de
  espera/validación, nunca `take` ni `release`.
- `show` conserva la metadata cruda sin adaptación especial.
- `plugins/query` conserva el mismo bucket y summary que CLI.
- UI server, selectores, filtros, token visual, NodeDetail, Overview y Board
  muestran `submitted` como estado/columna distinguible sin rediseñar el
  producto.

El protocolo de worker termina después de commit, evidencia y:

```text
submit -> submitted
```

Nunca ejecuta `accept` ni usa `resolve` para cierre automático. Su salida
conserva `WORKTREE`, commit y `EVIDENCE` para permitir auditoría.

El validator toma exclusivamente una task `submitted`. Tras comprobar
worktree, aceptación y evidencia:

```text
PASS: merge --no-ff -> accept -> done
FAIL: reject --reason -> open
BLOCKED: no muta el lifecycle; deja evidencia y solicita resolución
```

Un FAIL no crea automáticamente otra task: la misma task vuelve a ser
claimable. El validator conserva sus restricciones de no implementar fixes y
sólo mergea antes de `accept`; si merge o evidencia no permiten decidir,
reporta `BLOCKED`.

## Consecuencias

- A favor: la cola de validación es visible y no compite con `ready`.
- A favor: worker y validator representan ownership distinto sin sobrecargar
  `claim`.
- Coste: el protocolo portable y tests UI tienen varias listas cerradas que
  deben mantenerse en sincronía.
- Riesgo: aceptar antes de merge dejaría `done` sin integración; el orden está
  fijado como merge exitoso y luego `accept`.

## Plan de implementacion

1. Actualizar status/context/plugin query y contratos de salida sobre CLI
   terminado.
2. Actualizar UI server y frontend con verificación UI proporcional.
3. Cambiar skills y agentes worker/validator en el mismo corte documental.
4. Cerrar con pruebas end-to-end de submit/accept/reject, proyecciones y
   workflow portable.

## Onboarding breve para crear tasks

- [x] Realizado: read-model/CLI/plugin query, UI y protocolos portables no
  comparten paths; pueden avanzar en paralelo tras los adapters. La task final
  concentra sólo integración/test de contratos entre esos cortes.

## Verificacion

`npm test` y `npm run test:ui` deben quedar verdes. Los tests verifican que
`submitted` aparece en summary/bucket/filtros y UI, no se muestra como ready o
blocked, y que las instrucciones y scripts usan `submit`; un PASS de validator
hace merge y `accept`, y un FAIL usa `reject` sobre la misma task.
