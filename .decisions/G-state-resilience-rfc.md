# RFC: aislamiento de smoke y recuperación de estado

- Gate: `G-state-resilience-rfc` · Iniciativa: `state-resilience` · Estado: en review
- Autor: orchestrator · Fecha: 2026-08-25

## Problema

Un validador ejecutó un smoke que copió `.climier.json` hacia un proyecto temporal. Ese archivo conserva el `project_id`, por lo que el proceso apuntó al mismo `CLIMIER_HOME` real. Al ejecutar `climier init --force`, `src/commands/init.mjs` reemplazó el estado activo con `emptyState()` sin snapshot previo. Se perdió el grafo y el historial local de coordinación.

El aislamiento de `test/helpers.mjs` solo cubre el runner de tests: no protege comandos de smoke ejecutados manualmente por workers o validadores. El modelo actual requiere que los worktrees compartan el mismo `project_id`; no se debe romper esa propiedad para resolver el problema.

## Propuesta

Implementar dos defensas complementarias.

1. **Sandbox obligatorio para smoke de agentes.** Proveer un helper de shell versionado para workers y validadores que cree un `CLIMIER_HOME` temporal privado, lo exporte únicamente al comando de smoke y lo elimine al finalizar. Los protocolos prohíben ejecutar `init`, `init --force` u otra mutación de prueba sin ese helper. Los checks de validación contra la task real siguen usando el `CLIMIER_HOME` real y solo comandos de lectura, `add-note` y el merge permitido.

2. **Snapshots y restore del estado.** Antes de que `init --force` reemplace un `tasks.json` existente, el CLI guarda una copia raw inmutable en el directorio de estado del proyecto, bajo `snapshots/`. Agregar:
   - `climier snapshots`: lista snapshots con id, timestamp, tamaño y motivo;
   - `climier restore <snapshot-id> --as <agent>`: valida que el snapshot sea un estado v2, crea primero un snapshot del estado actual con motivo `pre_restore`, restaura atómicamente bajo el lock existente y agrega una entrada de log `restore`.

Los snapshots son locales al `CLIMIER_HOME`, heredan permisos restrictivos (`0700` directorio, `0600` archivos) y no se agregan a Git. Para no perder evidencia, esta primera entrega no hace pruning automático.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Cambiar el `project_id` por worktree | Aísla por defecto | Rompe la coordinación real: workers dejan de compartir claims, gates y DAG. |
| Solo añadir una prohibición en prompts | Cambio mínimo | Un agente puede ignorarla; no protege scripts ni errores humanos. |
| Solo snapshots | Permite recuperación | El incidente sigue interrumpiendo el estado y puede confundir workers activos. |
| **Sandbox para smoke + snapshots/restauración** | Evita el incidente y permite reversión recuperable | Añade dos comandos y disciplina explícita para smoke. |

## Alcance

- Dentro:
  - helper versionado para ejecutar smoke con `CLIMIER_HOME` temporal;
  - actualización de los protocolos de worker y validator;
  - pruebas que demuestren que un proyecto temporal con el mismo `project_id` no toca el home de control cuando usa el helper;
  - snapshots automáticos previos a `init --force` sobre un estado existente;
  - comandos read-only `snapshots` y mutante `restore`;
  - tests de snapshot, restore, aislamiento, validación de snapshot y atomicidad bajo lock;
  - documentación de operación y recuperación.
- Fuera:
  - confirmar `init --force` con un token o project id adicional;
  - sincronización remota, cifrado, backup externo o versionar `tasks.json` en Git;
  - retention/pruning automático;
  - cambiar el modelo de `project_id` compartido entre worktrees;
  - recuperar retroactivamente el historial perdido en este incidente.

## Riesgos y open questions

- Un snapshot corrupto o v1 no debe restaurarse silenciosamente → `restore` valida versión 2 y esquema antes de reemplazar el estado.
- Restaurar también es destructivo → se toma `pre_restore` antes de reemplazar y se usa el mismo lock del proyecto.
- Un helper puede omitirse → los protocolos lo hacen obligatorio y las pruebas cubren el caso que causó el incidente; el CLI no puede distinguir por sí solo un smoke de una operación legítima.
- Snapshots sin pruning crecen con resets → `init --force` es excepcional y el crecimiento es preferible a perder recuperación; retention queda fuera de este RFC.

## ADRs derivados

- [ ] ADR-004: aislamiento de smoke de agentes y contrato de snapshots/restauración → `.adrs/004-state-resilience.md`
