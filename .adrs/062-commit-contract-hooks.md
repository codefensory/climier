# ADR-062: Contrato de commits, hooks y enforcement

- Gate: `G-adr062-commit-contract` · Deriva de: `G-release-engineering-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

El historial mezcla Conventional Commits con mensajes libres (`Merge task T-urls-command`, `Add urls command`, `T-ui-dm-guards`). No hay hooks (`core.hooksPath` sin setear, no existe `.githooks`) ni commitlint. La automatizacion de release (ADR-063) depende de commits convencionales, y la trazabilidad commit→DAG no existe hoy. `climier show <id>` devuelve exit 0 si el nodo existe y `NODE_NOT_FOUND` con exit 1 si no (medido: ~0.37 s, backend remoto).

## Decision

- **Contrato:** `<type>(<scope>)!?: <subject> [<node-id>]`, con `type` en `feat fix docs style refactor perf test build ci chore revert`, `scope` opcional, `!` para breaking y **`[<node-id>]` obligatorio al final del subject**.
- **Hook `commit-msg` versionado** en `.githooks/commit-msg` (shim) + logica testeable en `scripts/check-commit-msg.ts`. Instalacion explicita: `bun run setup:hooks` → `git config core.hooksPath .githooks` (no via `prepare`, para no dispararse en instalaciones globales de consumidores).
- **Exenciones:** `Merge ...`, `Revert "..."`, `fixup!/squash!/amend!` y commits de release (`release: v...`, `chore(release):`).
- **Validacion en dos fases:** formato (local, instantaneo) y existencia del nodo via `climier show <id>` (**fail-closed**). El mensaje distingue `NODE_NOT_FOUND` (el id no existe) de DAG inalcanzable (sin credenciales/offline/timeout).
- **Escapes explicitos:** `git commit --no-verify` salta todo el hook; `CLIMIER_COMMIT_NO_TASK=1` salta solo el chequeo contra el DAG y conserva el formato.
- **Enforcement en CI:** commitlint bloqueante en `pull_request`; audit **no bloqueante** de commits sin `[node-id]` en `push` a `main`. No se hace bloqueante para no matar el escape por diseno.
- **Dependencia cross-repo:** el runner (`climier-flow`) debe emitir commits convencionales con `[T-id]` en ambos caminos (Worker y fallback `validatorCommit`). Sin eso, el hook local no garantiza el formato de lo que llega a main.

## Consecuencias

- A favor: trazabilidad commit→DAG; CHANGELOG automatico confiable (ADR-063); exenciones claras para el runner y git.
- En contra / deuda: cada commit pasa a depender de red y disponibilidad del server (fail-closed); `--no-verify` permite commits no-convencionales que quedan fuera del CHANGELOG; el runner debe cambiar en otro repo.

## Plan de implementacion

1. **Logica del hook** — archivos: `scripts/check-commit-msg.ts` (nuevo), `test/check-commit-msg.test.ts` (nuevo).
2. **Instalacion del hook** — archivos: `.githooks/commit-msg` (nuevo), `package.json` (script `setup:hooks`).
3. **Enforcement de CI** — archivos: `.github/workflows/ci.yml`, `commitlint.config.mjs` (nuevo), `package.json` (devDependency `@commitlint/cli` + `config-conventional`).
4. **Runner convencional (cross-repo)** — archivos: `climier-flow.config.json`, `flows/climier-flow/nodes/commit/run.js`, `test/flow-nodes.test.js` (en el repo `climier-flow`).
5. **Documentar el contrato y los escapes** — archivos: `README.md`, `docs/reference.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths y acceptance por pieza. La task del runner vive en otro repo y se registra como dependencia real.

## Verificacion

- Tests unitarios: mensaje valido pasa; tipo invalido, falta de `[id]` y id inexistente fallan; cada exencion pasa; timeout de red falla con mensaje diferenciado.
- `git commit` con mensaje invalido es rechazado por el hook; el mismo commit con `--no-verify` pasa.
- `CLIMIER_COMMIT_NO_TASK=1` permite un mensaje convencional sin `[id]` y rechaza uno no-convencional.
- En CI, commitlint falla un PR con un commit no-convencional y el audit de `main` reporta sin bloquear.
