# RFC: aislamiento de smoke y recuperación de estado

- Gate: `G-state-resilience-rfc` · Iniciativa: `state-resilience` · Estado: aprobado
- Autor: orchestrator · Fecha: 2026-08-25

## Problema

Un validador ejecutó un smoke que copió `.climier.json` hacia un proyecto temporal. Ese archivo conserva el `project_id`, por lo que el proceso apuntó al mismo `CLIMIER_HOME` real. Al ejecutar `climier init --force`, `src/commands/init.mjs` reemplazó el estado activo con `emptyState()` sin snapshot previo. Se perdió el grafo y el historial local de coordinación.

El aislamiento de `test/helpers.mjs` solo cubre el runner de tests: no protege comandos de smoke ejecutados manualmente por workers o validadores. El modelo actual requiere que los worktrees compartan el mismo `project_id`; no se debe romper esa propiedad para resolver el problema.

## Propuesta

Implementar dos defensas complementarias.

1. **Sandbox obligatorio para smoke de agentes.** Crear `.agents/skills/climier/smoke-sandbox.sh`, invocable como:

   ```bash
   bash .agents/skills/climier/smoke-sandbox.sh -- <comando> [args...]
   ```

   El helper exige `--`, crea un directorio propio con `mktemp -d`, aplica `umask 077`, exporta un `CLIMIER_HOME` dentro de él, ejecuta el comando como argv sin modificar stdout/stderr, propaga exactamente su código de salida y elimina el sandbox mediante `trap` para `EXIT`, `HUP`, `INT` y `TERM`. Un `SIGKILL` no permite cleanup; el directorio aislado residual no puede afectar el home real. Debe cubrir ambos casos: un proyecto temporal que copió `.climier.json` y uno nuevo sin metadata. Workers y validators deben usarlo para cualquier smoke que ejecute `init`, `init --force` o una mutación de Climier fuera del proyecto real; sus protocolos deben prohibir esas invocaciones directas.

2. **Snapshots y restore del estado.** Antes de que `init --force` reemplace un `tasks.json` existente, el CLI guarda una copia raw inmutable. El snapshot también se toma cuando `init` entra al recovery de JSON corrupto sin `--force`, de modo que el contenido no parseable queda preservado aunque no sea restaurable por el CLI v2.

   - Ubicación: `<CLIMIER_HOME>/projects/<project_id>/snapshots/`.
   - Identificador: `<UTC-YYYYMMDDTHHMMSSmmmZ>-<reason>-<8-hex-random>`, con `reason` en `force-init`, `corrupt-recovery` o `pre-restore`.
   - Archivos: `<id>.json` contiene los bytes raw del estado; `<id>.meta.json` contiene `{ id, created_at, reason, bytes, sha256 }`. El listado ignora pares incompletos.
   - Creación: dentro del mismo `withLock(projectDir)` que el reset/restore; raw y metadata usan archivo temporal más `rename`. `init.mjs` ya obtiene ese lock y debe conservarlo sobre snapshot y write.
   - Permisos: el directorio se crea con modo `0700` y los archivos con `0600` en plataformas Unix; en Windows se aplica `chmod` como mejor esfuerzo y la ACL queda bajo control del sistema operativo.
   - `climier snapshots`: lectura, devuelve `{ snapshots: [...] }` con `id`, `created_at`, `reason` y `bytes`, ordenados del más reciente al más antiguo. Es tolerante a archivos incompletos y no muta.
   - `climier restore <snapshot-id> --as orchestrator|recovery`: valida el id exacto, lee y valida el target como JSON v2 con las colecciones requeridas, toma un snapshot `pre-restore` del estado actual raw —incluso si este está corrupto—, reemplaza atómicamente el estado bajo el mismo lock y agrega `{ action: "restore", agent, snapshot_id }` al log restaurado. Devuelve `{ snapshot }`. Un snapshot ausente, corrupto, v1 o de shape inválida falla sin alterar el estado. Ningún otro agente puede restaurar.

No hay pruning automático en esta primera entrega: un reset es excepcional y conservar recuperación vale más que ahorrar espacio. La retención por cantidad o edad queda como trabajo futuro explícito.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Cambiar el `project_id` por worktree | Aísla por defecto | Rompe la coordinación real: workers dejan de compartir claims, gates y DAG. |
| Solo añadir una prohibición en prompts | Cambio mínimo | Un agente puede ignorarla; no protege scripts ni errores humanos. |
| Solo snapshots | Permite recuperación | El incidente sigue interrumpiendo el estado y puede confundir workers activos. |
| **Sandbox para smoke + snapshots/restauración** | Evita el incidente y permite reversión recuperable | Añade dos comandos y un helper obligatorio para smoke. |

## Alcance

- Dentro:
  - helper versionado y protocolos de worker/validator para smoke aislado;
  - prueba subprocess que reproduce un `.climier.json` copiado con el mismo `project_id`, ejecuta `init --force` mediante el helper y demuestra que el sentinel del home de control queda intacto;
  - módulo de snapshots, comandos `snapshots` y `restore`, wiring de `init`, help y documentación;
  - pruebas de snapshot previo a force-init y corrupt-recovery, restore válido, target corrupto/v1/ausente, `pre-restore`, log y exclusividad de autoridad;
  - pruebas de concurrencia/atomicidad proporcionales a `withLock`.
- Fuera:
  - confirmación adicional de `init --force` con token o project id;
  - sincronización remota, cifrado, backup externo o versionar `tasks.json` en Git;
  - retention/pruning automático;
  - cambiar el modelo de `project_id` compartido entre worktrees;
  - recuperar retroactivamente el historial perdido en este incidente.

## Riesgos y open questions

- Un helper puede omitirse → los protocolos deben usar el helper como único entry point para smoke mutante; el snapshot es la segunda barrera si se incumple.
- Un snapshot corrupto, v1 o incompleto no debe restaurarse silenciosamente → `restore` valida target antes de snapshotear/reemplazar; solo metadata+raw completos aparecen en el listado.
- Restaurar también es destructivo → se toma `pre-restore` antes de reemplazar y se restringe a `orchestrator|recovery`.
- Estado corrupto actual → se conserva como raw snapshot; el CLI v2 solo restaura snapshots v2 válidos.
- Snapshots sin pruning crecen con cada reset → se registra como follow-up de retention; no se sacrifica recuperación en la primera entrega.

## ADRs derivados

- [x] ADR-004: aislamiento de smoke de agentes y contrato de snapshots/restauración → `.adrs/004-state-resilience.md`
