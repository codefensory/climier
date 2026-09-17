# Migración Bun dual-runtime (Node+Bun compatibles)

## Goal

El repo corre verde bajo **ambos** runtimes sin reescribir imports: `climier` estable sigue en Node y `climier-dev` corre el worktree bajo Bun, con la suite core en verde en los dos.

- Verification: `npm test` (node) exit 0 **y** suite core bajo `bun` exit 0, más `climier-dev status` en proyecto temporal exit 0.
- Deliverables: copia estable aislada + symlink `climier-dev`, scripts/CI duales, `.plans/migrate-bun-dual-runtime.md` (este archivo).

## Objective

Hacer el repo ejecutable y testeable bajo Bun 1.3.14 manteniendo compatibilidad Node ≥20: hoy hay 0 usos de `Bun.*` y todo el core es stdlib `node:` (que Bun ya ejecuta por compat), así que la migración es de empaquetado/runner/CI/docs, no de lógica. Primero aislar el binario estable que hoy apunta directo al worktree, para no romper el uso diario en otros repos.

## Scope

- In scope: copia estable `~/code/climier-stable` + re-apunte de symlink + `climier-dev`; scripts `package.json` duales; matriz CI node+bun; `ui/` scripts bun; docs (README/AGENTS/CHEATSHEET); paridad de tests bajo ambos runtimes.
- Out of scope: reescritura Bun-only (`Bun.file`/`Bun.spawn`/`bun:test`, romper `node:`); nuevas dependencias; `AsyncLocalStorage` (se queda `node:async_hooks`, sin equivalente Bun); feature `--body-file`; carpeta `src/utils/`; cambios de lógica en kernel/storage/providers.

## Verified Context

- `~/.local/bin/climier -> /home/leobar37/code/climier/bin/climier.mjs` (symlink 13-sep): el estable **es** este worktree; cualquier edición pega a otros repos.
- Toolchain máquina: `bun 1.3.14`, `node v22.22.3`, `npm 10.9.8`.
- `src+bin`: 109 `.mjs`, 18 importan `node:` (`path` 11x, `fs/promises` 9x, `fs` 4x, `crypto` 2x, `child_process`, `url`, `async_hooks`, `os`), 0 usan `Bun.*`.
- `test/`: 125 files, 122 usan `node:test` (Bun lo implementa, runner distinto pero imports compatibles).
- `package.json`: `engines node>=20`, scripts con `node test/run-core-tests.mjs` y `node --test`; CI `setup-node@v4` solo Node.
- `bin/climier.mjs` ya lleva shebang `#!/usr/bin/env bun`.
- `ui/`: subproyecto con `express`, `engines node>=20`, `dev:api: node server/server.mjs`.
- Rama actual `ui-bind-host` con untracked `src/ui`, `ui/bun.lock` (la copia estable debe incluirlos o pinearse con decisión explícita).
- `CLIMIER_HOME` no seteado → estado vivo en `~/.climier/projects/` (5 proyectos); `.climier.json` local `project_id b4e2c579bbb81669`.

## Assumptions

- Estrategia dual elegida por el usuario: mantener `node:` y sumar Bun como runtime soportado (ya hay commit `docs: note Bun as a supported runtime`).
- Copia estable en `~/code/climier-stable`; dev en este worktree como `climier-dev` (symlink en `~/.local/bin`, sin tocar `package.json:bin`).
- Bun ejecuta `node:test`/`node:assert` lo bastante bien para la suite core; divergencias se registran, no se reescriben tests en esta fase.

## Files Involved

- N/A (fuera del repo) - Create - copia `~/code/climier-stable` + symlinks `~/.local/bin/climier`, `~/.local/bin/climier-dev`.
- `package.json` - Modify - scripts duales (`test:bun`, `test:ui:bun`, resto intacto).
- `bin/climier.mjs` - Review - shebang ya Bun; verificar exec directo sin `node`/`bun` explícito.
- `.github/workflows/*` - Modify - matriz node 20/22 + bun 1.3.x.
- `ui/package.json`, `ui/server/server.mjs` - Modify/Review - variante `dev:api:bun`, smoke bajo Bun (express corre en Bun).
- `README.md`, `AGENTS.md`, `CLIMIER-CHEATSHEET.md` - Modify - sección runtime dual + uso `climier-dev` con `CLIMIER_HOME` sandbox.
- `test/run-core-tests.mjs`, `test/helpers.mjs` - Review - deben pasar sin cambios bajo `bun`; solo adaptar si hay divergencia de runner documentada.

## Ordered Execution Steps

1. **[Aislar el estable y crear climier-dev]**
   - Context: hoy el symlink estable apunta al worktree; sin este paso la migración rompe el uso diario. Nada posterior es seguro sin esto.
   - Files: N/A (shell, fuera del repo).
   - Action: snapshot del worktree incl. untracked a `~/code/climier-stable`, re-apuntar `climier` allí, crear `climier-dev` al worktree. Comandos (revisar antes de correr):
     ```bash
     git -C ~/code/climier status --short --branch
     mkdir -p ~/code/climier-stable && cp -a ~/code/climier/. ~/code/climier-stable/
     ln -sfn ~/code/climier-stable/bin/climier.mjs ~/.local/bin/climier
     ln -sfn ~/code/climier/bin/climier.mjs ~/.local/bin/climier-dev
     readlink ~/.local/bin/climier ~/.local/bin/climier-dev
     climier status --project /tmp/smoke-stable && climier-dev status --project /tmp/smoke-dev
     ```
   - End State: `climier` resuelve a la copia, `climier-dev` al worktree, ambos responden `status` en proyectos temporales.
   - Verification: `readlink` de ambos symlinks + `status` exit 0 en `/tmp` (nunca en un repo real).
   - Depends on: none.

2. **[Fijar línea base verde en Node]**
   - Context: punto de comparación; si Node está rojo, nada de Bun es interpretable (regla repo: nunca commitear sobre rojo).
   - Files: `test/`, `package.json`.
   - Action: `npm test` y `npm run test:concurrent` en el worktree; anotar fallos preexistentes si los hay.
   - End State: baseline Node documentada (idealmente exit 0).
   - Verification: `npm test; echo $?` + `npm run test:concurrent; echo $?`.
   - Depends on: 1.

3. **[Paridad de suite bajo Bun sin tocar tests]**
   - Context: el riesgo real de la fase dual está en el runner (`node --test` vs `bun`), no en el código (stdlib `node:` ya soportado).
   - Files: `test/run-core-tests.mjs`, `test/helpers.mjs` (review), `package.json` (añadir `test:bun`, sin cambiar `test`).
   - Action: correr core + concurrentes bajo `bun` (p. ej. `bun test/run-core-tests.mjs`, `bun --test test/` según lo que el runner acepte); registrar divergencias (spawn de `runCli` en helpers, `process.stdin` en `batch`, timers del lock) como lista, no parchear tests aún.
   - End State: lista de gaps bun-vs-node cerrada (cero gaps, o gaps numerados con causa).
   - Verification: salidas/exit codes de ambas corridas guardados en la nota de avance.
   - Depends on: 2.

4. **[Scripts y binario dev documentados]**
   - Context: `climier-dev` debe ser usable sin `cd` ni prefijos raros y sin contaminar `~/.climier` real.
   - Files: `package.json`, `bin/climier.mjs` (review).
   - Action: añadir `test:bun` / `test:ui:bun`; verificar ejecución directa `./bin/climier.mjs status` y `climier-dev` desde otro cwd; patrón sandbox `CLIMIER_HOME=/tmp/climier-home climier-dev ...`.
   - End State: `climier-dev status --project /tmp/x` funciona desde cualquier cwd con home sandbox.
   - Verification: comando anterior exit 0 + `head -1 bin/climier.mjs` sigue shebang bun.
   - Depends on: 1.

5. **[CI dual node+bun]**
   - Context: sin CI dual, la paridad se pudre al primer commit.
   - Files: `.github/workflows/*`.
   - Action: matriz `node 20/22` (existente) + `bun 1.3.x` corriendo `test` y `pack:check`; decidir si bun es gate o `allow-failure` inicial según gaps del paso 3.
   - End State: workflow en verde en ambas runtimes (o bun en allow-failure explícito con issue de gaps).
   - Verification: run de CI en rama de prueba.
   - Depends on: 3.

6. **[UI bajo Bun (solo smoke)]**
   - Context: `ui/` es el único con dependencia externa (`express`); es subproyecto y no exige TDD, solo verificación proporcional.
   - Files: `ui/package.json`, `ui/server/server.mjs` (review).
   - Action: `dev:api:bun`, boot `climier-dev ui --port` contra proyecto temporal, un request `/api/snapshot`; no tocar frontend.
   - End State: server levanta bajo Bun y sirve snapshot de proyecto temporal.
   - Verification: `curl /api/snapshot` 200 + log de arranque citado en el commit/PR.
   - Depends on: 4.

7. **[Docs de runtime dual]**
   - Context: el contrato operativo cambia (dos binarios, dos runners); si no se escribe, el próximo agente usa el binario equivocado.
   - Files: `README.md`, `AGENTS.md`, `CLIMIER-CHEATSHEET.md`.
   - Action: sección corta: `climier` (estable/Node) vs `climier-dev` (worktree/Bun), `CLIMIER_HOME` sandbox, comandos de verificación. Actualizar tabla Quick reference si cambia superficie (no cambia).
   - End State: un lector nuevo sabe qué binario usar sin preguntar.
   - Verification: `grep -r climier-dev README.md AGENTS.md CLIMIER-CHEATSHEET.md`.
   - Depends on: 4.

## Risks and Edge Cases

- Symlink swap apunta mal y el `climier` diario queda roto → verificar `readlink` + smoke en `/tmp` antes de dar el paso por hecho; rollback = `ln -sfn ~/code/climier/bin/climier.mjs ~/.local/bin/climier`.
- Untracked `src/ui`, `ui/bun.lock` fuera de la copia → el estable diverge del worktree; decidir en paso 1 si se incluyen (`cp -a` los lleva) o se pinean por commit.
- `bun` y `node:test`: `runCli` vía spawn en `helpers.mjs` puede comportarse distinto (shebang/env); si falla, es gap de harness, no de dominio.
- `process.stdin` (`batch --stdin`) y `spawn/spawnSync` (`install`/`ui`) son los puntos con más divergencia Bun; aislarlos en la lista de gaps.
- Estado real en `~/.climier`: todo smoke con `--project /tmp/...` y `CLIMIER_HOME` temporal; jamás `init/restore` contra proyectos vivos.
- `ui/` trae `express`: corre en Bun, pero si hay quirk, ese paso se declara allow-failure sin bloquear el core.

## Validation Strategy

- `npm test` + `npm run test:concurrent` (Node, debe seguir verde: cero regresiones para usuarios estables).
- Suite core bajo Bun exit 0 o gaps numerados con causa raíz.
- `climier-dev status/context/take/submit` en proyecto temporal con `CLIMIER_HOME=/tmp/...` (flujo agente completo en sandbox).
- `npm run pack:check` en CI dual.
- `curl /api/snapshot` 200 para `ui` bajo Bun.

## Open Questions

- ¿La copia estable incluye los untracked (`src/ui`, `ui/bun.lock`) o se pinea al commit `da7d6d4` limpio?
- ¿Bun en CI es gate desde el día 1 o `allow-failure` hasta cerrar gaps del paso 3?
- ¿`~/code/climier-stable` es la ruta final o prefieres `~/.local/share/climier-stable`?

## Execution record (2026-09-17, bun 1.3.14 / node v22.22.3)

- Step 1 done: `~/code/climier-stable` snapshot via `cp -a` (untracked
  `src/ui`, `ui/bun.lock`, `.plans/` included — answers Open Q 1 and 3).
  `~/.local/bin/climier -> climier-stable/...`, `climier-dev -> worktree/...`;
  both `status` exit 0 on temp projects.
- Step 2 done: `npm test` 1334 pass / 0 fail; `test:concurrent` 82 / 0.
- Step 3 done: `bun test/run-core-tests.mjs` does NOT work (spawns
  `bun --test`, unsupported). `bun test <files>` in one process cascades:
  GAP-3 systemic — after any failing test, later files die with
  `test() inside another test()` (ERR_NOT_IMPLEMENTED, Bun#5090-adjacent).
  Per-file sweep (109 files): only 2 fail alone.
- Step 4 done: `test/run-bun-tests.mjs` (per-file `bun test`, mitigates
  GAP-3, no test changes) + `test:bun` / `test:ui:bun` scripts. Full run:
  109/110 files green. `climier-dev init/add-initiative/add-task/status`
  verified from foreign cwd with `CLIMIER_HOME` sandbox.
- Step 5 done: CI split `test-node` (gate) + `test-bun` pinned
  `oven-sh/setup-bun@v2 bun 1.3.14`, `continue-on-error: true` until gaps
  close (answers Open Q 2: allow-failure first).
- Step 6 done: `ui` `dev:api:bun` script; server under Bun serves
  `/api/health` 200 and live `/api/snapshot` on sandbox project.
- Step 7 done: `climier-dev` documented in README / AGENTS.md / CHEATSHEET.

### Bun gap list

- GAP-1 (deterministic, 4/4 bun / 0/3 node): `kernel-state-operations`
  "rejects malformed target" asserts `readdir` returns
  `["bad.json","bad.meta.json"]`; Bun returns `["bad.meta.json","bad.json"]`
  on the same FS. Test assumes readdir order (never guaranteed).
  Proposed: sort before comparing (test-only). Needs approval.
- GAP-2 (flaky ~2/3 bun, 0/2 node): `v2-status-history` stale-claim with
  `--stale-ms 0` expects 2 alerts, gets 0 when take→status lands in the same
  ms. Root cause: `age > staleMs` (strict) in `status.mjs`,
  `context.mjs` (x2), `plugins/query.mjs` (x2) contradicts the documented
  contract "`staleMs: 0` means everything in_progress is stale". Bun is just
  fast enough to hit age==0. Proposed: `>=` (product semantics change).
  Needs approval.
- GAP-3 (systemic, mitigated): single-process `bun test` cascade described
  above; `run-bun-tests.mjs` isolates per file. No action unless Bun fixes
  the shim.

### Gap closure (continuation, same day)

- GAP-1 closed (test-only): `kernel-state-operations` now sorts `readdir`
  before comparing — order was never guaranteed. Green node + bun (3/3).
- GAP-2 closed (src, 6 sites): `age > staleMs` → `age >= staleMs` in
  `status.mjs` (`detectStaleClaims`), `context.mjs` (`buildClaim` x2),
  `plugins/query.mjs` (`staleClaims`, `claimFor` x2). This matches the
  documented contract ("`staleMs: 0` means everything in_progress is
  stale"); strict `>` only passed on Node because slower ops kept age ≥1ms.
  No other test depends on the strict boundary (only epoch-1000 and
  MAX_SAFE_INTEGER cases). Green node + bun (5/5 flaky file).
- Full evidence: `npm test` 1334/0 exit 0, `test:concurrent` 82/0 exit 0,
  `npm run test:bun` 110/110 files exit 0, `climier-dev status` exit 0.
- CI `test-bun` promoted from `continue-on-error` to hard gate.

### UI suite note (out of scope, pre-existing)

- `npm run test:ui` (node) hangs in `ui-nav bootApp` past 600s on this
  machine; `bun test test/ui-*` single-process shows failures. Both are
  pre-existing UI-env issues (no UI source touched: only a `dev:api:bun`
  script added). Core/CLI scope unaffected — `npm test` excludes `ui-*` by
  design. UI parity is follow-up work, not this goal.
