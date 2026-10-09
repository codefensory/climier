---
name: climier-release
description: "Corta una release de climier desde main: analiza los commits desde el ultimo tag, propone la version semver (los cambios solo de docs/ NO cuentan), audita README, AGENTS.md y docs contra los cambios, actualiza package.json y CHANGELOG, y publica en npm con bun run release. Usar cuando pidan release, nueva version, cortar/cortar una release, preparar release, actualizar CHANGELOG, o publicar en npm."
---

# climier-release — de main a npm

Flujo del release owner. El mecanismo de publicacion esta fijado en
`.adrs/071-release-local-publish.md`: el publish de npm es local e interactivo
(2FA), CI no publica. El checklist resumido vive en `README.md` § Release
checklist.

```
main verde -> analizar -> proponer -> auditar docs -> aplicar -> commit -> publicar -> CI adjunta binarios
```

## Regla de oro

**Los cambios que solo tocan `docs/` NO cuentan como release.** Ni bumpean la
version ni justifican publicar. El sitio de documentacion se despliega solo por
`.github/workflows/docs.yml` al pushear `docs/**`. El planner ya implementa esto:
un commit suma al bump solo si toca al menos un path fuera de `docs/` y su tipo
es `feat` (minor), `fix`/`perf` (patch) o es breaking (major).

Cualquier otro tipo (`docs`, `chore`, `ci`, `test`, `style`, `build`, `refactor`)
aparece en el CHANGELOG pero no mueve la version.

## Precondiciones

- Estar en `main`, con `git pull` al dia y arbol limpio.
- `bun` 1.4+ y dependencias instaladas.
- Para publicar: `npm login` (sesion con 2FA) y `gh auth status`.
- Todo el trabajo ya integrado en `main` (el corte no sale de una rama).

## Paso 1 — Analizar los cambios

Corre el planner determinista. Usa el ultimo tag `v*` alcanzable como base:

```sh
bun scripts/release-plan.ts
# override de base si hace falta:
bun scripts/release-plan.ts --base v1.0.0
```

Devuelve JSON con `baseTag`, `baseVersion`, `bump`, `nextVersion`,
`releaseWorthy`, `docsOnly`, `changelog` y la clasificacion commit por commit.
Revisa la clasificacion: corrige tipos mal etiquetados en la fuente (no en el
plan) y confirma si el cambio rompe compatibilidad.

## Paso 2 — Proponer (gate de confirmacion)

Presenta al usuario, corto y explicito:

1. **Base y alcance**: ultimo tag y rango de commits.
2. **Version propuesta**: `bump` + `nextVersion` + por que (que commits lo
   justifican y cuales quedan excluidos por ser `docs/`).
3. **CHANGELOG borrador**: las secciones que devuelve el planner, con la prosa
   de migracion agregada a mano si el cambio lo exige.
4. **Gaps de documentacion** (paso 3).

Espera confirmacion antes de mutar, salvo que el usuario haya pedido
explicitamente cortar la release de una.

Si `releaseWorthy` es `false`: **no hay release**. Informa que solo hubo cambios
de documentacion/chore y termina (el sitio ya se despliega por su cuenta).

## Paso 3 — Auditar documentacion

Recorre el diff no-docs y contrasta contra los docs. Que falte un doc es un
bloqueo del release, no un "despues".

| Cambio | Revisar |
|---|---|
| Comando o flag nuevo/cambiado | `docs/reference.md`, `README.md` (Command reference), `AGENTS.md` (tabla de comandos) |
| Estado o esquema | `AGENTS.md` (State shape), `docs/reference.md`, `docs/content/docs/concepts/state-and-storage.mdx` |
| Server remoto | `docs/remote-server.md` (canonico), `README.md` (Remote v1) |
| Plugins | `docs/PLUGINS.md`, `docs/content/docs/reference/plugins.mdx` (generado) |
| UI | `docs/content/docs/reference/web-ui.mdx`, `docs/content/docs/guides/*` |
| Lifecycle / derivacion | `docs/content/docs/concepts/lifecycle.mdx`, `docs/content/docs/getting-started/*` |
| Release / publicacion | `README.md` § Release checklist, `.adrs/` si cambia la decision |

Guardrails obligatorios antes de commitear:

```sh
node docs/scripts/check-public-docs.mjs          # no filtra secretos/IPs/ADRs internos
node docs/scripts/sync-canonical.mjs             # regenera los .mdx (gitignored, NO commitear)
bun run surface:check                            # superficies retiradas
bun test/server-setup-docs.test.ts               # docs del server
bun run typecheck && bun run lint:cut
```

Recuerda: `docs/content/docs/reference/{cli,plugins,self-hosting}.mdx` son
generados desde los canonicos; se editan los canonicos, nunca los `.mdx`.

Si hay gaps: propone los cambios concretos (archivo + texto) y aplica edits con
su propio commit `docs(...)` y node id `[T-...]`, antes del commit de release.

## Paso 4 — Aplicar la version y el CHANGELOG

1. `package.json`: `"version"` = `nextVersion`. Es la unica fuente de version
   (ADR-061); no hay que tocar ningun otro archivo por version.
2. `CHANGELOG.md`: insertar arriba (despues del header) la seccion
   `## [<nextVersion>] - <YYYY-MM-DD>` con el borrador del planner y, si aplica,
   la prosa de migracion. Formato Keep a Changelog, igual que `## [1.0.0]`.
3. Verifica el gate que exige el script: la seccion exacta debe existir.

## Paso 5 — Commit y push

```sh
# docs primero, si hubo cambios de documentacion
git commit -m "docs(<scope>): ... [T-<id>]"
git add package.json CHANGELOG.md
git commit -m "chore(release): <nextVersion>"
git push origin main
```

El commit de release (`chore(release): ...` o `release: v...`) esta exento del
node id del contrato de commits. Docs y codigo necesitan su `[T-...]`/`[G-...]`.
Espera CI (`ci`, y `docs`/`ui` si tocaste esos paths) verde en ese commit.

## Paso 6 — Publicar

```sh
bun run release --dry-run   # gate completo + npm publish --dry-run (no publica)
bun run release             # gate + npm publish (pide el OTP 2FA) + tag + verify
```

El script valida arbol limpio, `main`, HEAD pusheado, CHANGELOG, sesion npm y que
la version no este publicada; corre `build:ui`, `typecheck`, `test`,
`surface:check`, `lint:cut`, `pack:check` y `smoke:pack`; publica con el dist-tag
`latest` (o `next` en prerelease); crea/empuja el tag `v<version>`; y verifica
`npm view`.

Orden seguro: npm primero, tag despues. Si el publish falla, no quedo tag
empujado y se reintenta limpio.

## Paso 7 — Verificar y cerrar

```sh
npm view climier version
gh release view v<nextVersion>          # CI crea el Release y sube binarios+manifest+SHA256SUMS
curl -sL https://github.com/codefensory/climier/releases/latest/download/manifest.json | head
climier upgrade --check                 # una instalacion existente ve el canal
```

Reporta: version publicada, URL de npm, Release y assets, y el resultado del CI
del tag. Si la release tenia tarea en el DAG, dejala aceptada por el runner o
agrega nota con la verificacion.

## Casos especiales

- **Solo docs**: `releaseWorthy: false`. No hay release; termina. El push a
  `main` ya desplego el sitio.
- **Tag congelado (bootstrap)**: si `v<version>` ya existe en otro commit
  (v1.0.0), el script corre gate y publish dentro de un worktree de ese tag para
  que el tarball coincida con el GitHub Release. No se mueve el tag.
- **Prerelease**: el script usa `--tag next`; el `manifest.json` de CI usa
  `--channel stable` fijo, asi que en v1 el canal soportado es **stable**.
- **Migracion de estado**: si cambia el esquema, antes del publish hay que
  ensayar `climier migrate --all --dry-run` con todos los writers parados y
  seguir `docs/remote-server.md`.
- **Recuperacion**: si el CI del tag falla en los assets, re-ejecuta el workflow;
  la subida es idempotente (`--clobber`). Si npm ya tiene la version, el script
  aborta solo.

## Referencias

- `.adrs/071-release-local-publish.md` — decision del publish local.
- `scripts/release-plan.ts` — planner de version y CHANGELOG.
- `scripts/release.ts` — corte, gate y publish.
- `README.md` § Release checklist — version resumida para humanos.
