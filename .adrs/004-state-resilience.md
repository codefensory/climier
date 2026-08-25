# ADR-004: sandbox de smoke y snapshots restaurables

- Gate: `G-adr004-state-resilience` · Deriva de: `G-state-resilience-rfc` · Estado: aprobado
- Fecha: 2026-08-25

## Contexto

El estado v2 se resuelve desde un `project_id` versionado en `.climier.json`, mientras que `CLIMIER_HOME` contiene el estado activo local. Copiar metadata a un proyecto temporal sin cambiar `CLIMIER_HOME` reutiliza la pizarra real. Un smoke de validador ejecutó `init --force` en esa combinación y reemplazó el estado sin backup.

El RFC `G-state-resilience-rfc` evaluó alternativas. Conservamos el `project_id` compartido entre worktrees y agregamos aislamiento para smoke más recuperación local ante resets.

## Decision

### Smoke aislado

`.agents/skills/climier/smoke-sandbox.sh` es el único entry point para smoke de agentes que ejecute un comando mutante de Climier sobre un proyecto temporal:

```bash
bash .agents/skills/climier/smoke-sandbox.sh -- <command> [args...]
```

Exige `--`; crea un directorio temporal privado; aplica `umask 077`; exporta `CLIMIER_HOME=<sandbox>/home`; ejecuta argv sin capturar ni alterar stdout/stderr; devuelve el mismo exit code; limpia en `EXIT`, `HUP`, `INT` y `TERM`. Un sandbox residual por `SIGKILL` es aceptable porque está aislado. El helper funciona tanto con `.climier.json` copiado como sin metadata. Los protocolos worker y validator prohíben `init`, `init --force` y mutaciones de smoke directas fuera de este helper.

### Snapshots

El estado del proyecto usa `<state-dir>/snapshots/`. Un snapshot tiene id:

```text
<UTC-YYYYMMDDTHHMMSSmmmZ>-<reason>-<8-hex-random>
```

`reason` es `force-init`, `corrupt-recovery` o `pre-restore`. `<id>.json` conserva bytes raw y `<id>.meta.json` contiene `{ id, created_at, reason, bytes, sha256 }`. Solo pares completos aparecen en el listado. La creación usa temp+rename dentro del mismo `withLock(projectDir)` que el reset o restore. En Unix se usan `0700` y `0600`; en Windows es best-effort.

`init --force` snapshottea siempre que exista un archivo previo. El recovery de `init` sobre JSON corrupto también snapshottea el raw antes de recrear el estado.

### Commands

- `snapshots` es read-only y devuelve `{ snapshots }`, ordenado descendentemente por id.
- `restore <snapshot-id> --as orchestrator|recovery` es el único restore admitido. Valida que el target exista, sea JSON v2 y tenga las colecciones requeridas; crea primero un snapshot raw `pre-restore` del estado actual; restaura con tmp+rename bajo el lock; agrega un log `{ action: "restore", agent, snapshot_id }`; devuelve `{ snapshot }`.
- Snapshots corruptos, incompletos, v1, futuros o con shape inválida fallan sin reemplazar estado. No hay pruning automático en esta entrega.

## Consecuencias

- A favor: los smokes no pueden afectar el home real si siguen el entry point; un reset conserva una ruta local de recuperación; restore conserva evidencia del estado que desplaza.
- En contra / deuda: snapshots pueden crecer sin límite; el sandbox no puede impedir que un proceso que ignore los protocolos invoque la CLI directamente; permisos Windows no equivalen necesariamente a 0600 Unix.
- Follow-up explícito: definir retention/pruning y, separadamente, una confirmación fuerte para `init --force`.

## Plan de implementación

1. Snapshot storage e integración con `init` — `src/state.mjs`, `src/commands/init.mjs`, `test/state-snapshots.test.mjs`, `test/init.test.mjs`.
2. Helper y protocolos de smoke — `.agents/skills/climier/smoke-sandbox.sh`, skills worker/validator, `test/smoke-sandbox.test.mjs`.
3. Listado y restore — `src/commands/snapshots.mjs`, `src/commands/restore.mjs`, `bin/climier.mjs`, docs y tests de comandos; depende de 1.
4. Regresión end-to-end — prueba subprocess con metadata copiada, home de control sentinel y sandbox; depende de 1–3.

## Verificación

- `node --test test/state-snapshots.test.mjs test/init.test.mjs`
- `node --test test/smoke-sandbox.test.mjs`
- `node --test test/snapshots-restore.test.mjs`
- `npm test`
- Smoke dirigido: un `init --force` ejecutado mediante el helper sobre metadata copiada no modifica un sentinel en otro `CLIMIER_HOME`; `snapshots` lista el backup; `restore` recupera la task sentinel y agrega su log.
