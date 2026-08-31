# ADR-015: Lifecycle `submitted` y semántica de aceptación

- Gate: `G-task-lifecycle-model-adr` · Estado: aprobado
- Fecha: 2026-08-31

## Contexto

Una task `done` desbloquea aristas `BLOCKS`, pero hoy un worker puede llegar a
ese estado antes de una validación independiente. Se necesita separar la
finalización de la implementación de la aceptación del resultado, sin añadir
un lifecycle de validators ni un modelo de attempts.

## Decision

El estado persistido nuevo es `submitted`. La matriz de transiciones queda:

| Operación | Desde | Hacia |
| --- | --- | --- |
| `take` | `open` | `in_progress` |
| `takeover` | `in_progress` | `in_progress` |
| `release` | `in_progress` | `open` |
| `submit` | `in_progress` | `submitted` |
| `reject` | `submitted` | `open` |
| `accept` | `submitted` | `done` |
| `reopen` | `done` | `open` |
| `cancel` | `open`, `in_progress`, `submitted` | `canceled` |
| `resolve` (compatibilidad manual) | `open`, `in_progress` | `done` |

`done` significa que el resultado es confiable para el resto del grafo. El
camino `resolve` persiste únicamente como declaración manual/bypass compatible:
quien lo usa asume explícitamente la aceptación; workers y flujos automáticos
no lo usan.

Sólo `done` y `archived` satisfacen una arista `BLOCKS`. `submitted` permanece
insatisfecho y no se deriva como `ready`, `blocked` ni `backlog`; es un estado
explícito. El conjunto interno que hoy mezcla `in_progress` con estados
terminales se renombra a una noción precisa de estados no abiertos.

El `claim` es ownership de implementación exclusivamente:

- `take` crea `{ by, at }` en `in_progress`.
- sólo `claim.by` puede ejecutar `submit`;
- `submit`, `accept`, `reject`, `cancel` y `reopen` dejan `claim: null`;
- no existe claim de validator en esta iniciativa.

`submit` guarda `submitted_by` y `submitted_at`. `accept` preserva esos
campos y escribe `done_by = submitted_by`, `done_at`, `accepted_by` y
`accepted_at`, todos con el instante de aceptación donde corresponda.
`reject` y `reopen` dejan en `null` la metadata de submission/acceptance del
ciclo anterior; `reopen` también deja `done_by` y `done_at` en `null`. La
razón de reject pertenece al log atómico de la mutación, no crea un estado ni
un intento nuevo.

La introducción de un estado con semántica de bloqueo no es segura para un
binario v2 anterior: lo interpretaría como una task abierta derivable. Por la
regla de compatibilidad del repositorio, el estado pasa a versión 3. El nuevo
lector migra de v2 a v3 preservando nodos, aristas, iniciativas y log; nuevas
mutaciones escriben v3. Un binario anterior debe rechazar v3, nunca derivarla.

Quedan fuera de alcance: `validating`, `rejected`, `needs_changes`, attempts,
artifacts, autoaceptación prohibida por kernel y leases/claims de validator.

## Consecuencias

- A favor: toda dependencia satisfecha por `done` representa trabajo aceptado.
- A favor: un reject reabre la misma unidad lógica y conserva el DAG.
- Coste: cambia la versión de estado y todos los consumidores deben reconocer
  `submitted`.
- Riesgo: una migración o derivación incompleta podría volver claimable una
  submission; tests puros y de CLI deben cubrirlo antes de exponer operaciones.

## Plan de implementacion

1. Migrar el almacenamiento v2→v3 y fijar la derivación de `submitted` —
   `src/storage/state.mjs`, `src/providers/task/derivation.mjs` y tests puros.
2. Implementar providers y transiciones sobre esta matriz.
3. Exponerlos en adapters y proyecciones después de que el contrato canónico
   esté cubierto.

## Onboarding breve para crear tasks

- [x] Realizado: la migración y derivación comparten contrato y van en una
  task fundacional exclusiva; los providers usan archivos separados; registry,
  CLI, workflow y proyecciones se integran después. El único riesgo añadido
  descubierto fue el versionado obligatorio de estado v3.

## Verificacion

`npm test` debe comprobar: migración v2→v3; rechazo de versiones futuras;
`submitted` no satisface `BLOCKS`; una descendiente sigue bloqueada hasta
`accept`; `reject` devuelve la task a `ready` cuando sus blockers ya están
satisfechos; y `reopen` deja en `null` toda metadata del ciclo anterior.
