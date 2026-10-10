---
name: climier-release
description: "Corta una release de climier desde main: analiza los commits desde el ultimo tag, propone la version semver (solo src/, bin/ y ui/ cuentan; docs, skills, .pi, tests, .github y scripts no), audita README, AGENTS.md y docs contra los cambios, actualiza package.json y CHANGELOG, y publica en npm con bun run release. Usar cuando pidan release, nueva version, cortar/cortar una release, preparar release, actualizar CHANGELOG, o publicar en npm."
---

# climier-release — de main a npm

Flujo del release owner. El mecanismo de publicacion esta fijado en
`.adrs/071-release-local-publish.md`: el publish de npm es local e interactivo
(2FA), CI no publica. El checklist resumido vive en `README.md` § Release
checklist.

```
main verde -> analizar -> proponer -> auditar docs -> aplicar -> commit -> publicar -> CI adjunta binarios
```

## Release manual, sin task en el DAG

Las releases de este repo las corta el maintainer a mano con este skill. No se
crean tasks en el DAG para cortar version, tag, publish ni lanzamiento, y no se
delegan al runner: el corte exige 2FA y credenciales de operador. El DAG solo
trackea el trabajo de producto o CI que habilita una release.

## Regla de oro

**Solo los cambios de producto cuentan como release.** Un commit suma al bump
solo si toca al menos un path de producto y su tipo es `feat` (minor),
`fix`/`perf` (patch) o es breaking (major). Los paths de producto son:

- `src/**` — CLI, server, kernel, providers, storage, plugins.
- `bin/**` — entrypoint publicado (`bin/climier.ts`).
- `ui/**` — fuente del UI (se empaqueta como `ui/dist`).

Todo lo demas queda fuera del bump aunque este etiquetado `feat`/`fix`:
`docs/`, `.pi/`, `.agents/`, `skills/`, `.adrs/`, `.decisions/`, `test/`,
`scripts/`, `.github/`, el `package.json` raiz (scripts de tooling, `engines`,
`files`) y los markdown raiz (`README.md`, `AGENTS.md`, `CLIMIER-CHEATSHEET.md`,
`CHANGELOG.md`, `LICENSE`). El sitio de documentacion se despliega solo por
`.github/workflows/docs.yml`. Si hiciera falta que un cambio de empaquetado
suelte release, se le agrega `package.json` al allowlist del planner.

Un rango que no toca producto devuelve `releaseWorthy: false` y **no hay
release**: ni version nueva ni publish. El CHANGELOG solo lista commits de
producto; el resto aparece en `excluded` con el motivo.

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
`releaseWorthy`, `excluded`, `changelog` y la clasificacion commit por commit
(`touchesProduct`, `releaseWorthy`).
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

Si `releaseWorthy` es `false`: **no hay release**. Informa que el rango no toca
producto (`src/`, `bin/`, `ui/`) y termina; la documentacion se despliega sola.

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
gh release view v<nextVersion>          # CI crea el Release (cuerpo = seccion del CHANGELOG + link de comparacion) y sube binarios+manifest+SHA256SUMS
curl -sL https://github.com/codefensory/climier/releases/latest/download/manifest.json | head
climier upgrade --check                 # una instalacion existente ve el canal
```

npm escanea una version nueva antes de exponerla, asi que entre `npm publish` y
`npm view` hay una ventana de varios minutos; en un paquete nuevo npm crea un
placeholder publico `0.0.0-stage` mientras procesa (es de npm, no es tuyo). La
linea `+ climier@X.Y.Z` del publish es la senal autoritativa: el script reintenta
`npm view` hasta ~5 min y, si aun no aparece, avisa sin fallar.

Reporta: version publicada, URL de npm, Release y assets, y el resultado del CI
del tag. La release no tiene task en el DAG: el reporte va al usuario, y las
tasks de producto que la habilitaron ya las cerro el runner.

## Casos especiales

- **Solo docs o tooling**: `releaseWorthy: false`. No hay release; termina. El
  push a `main` ya desplego el sitio.
- **Tag congelado (bootstrap)**: si `v<version>` ya existe en otro commit
  (v1.0.0), el script corre gate y publish dentro de un worktree de ese tag para
  que el tarball coincida con el GitHub Release. No se mueve el tag.
- **Prerelease**: el script usa `--tag next`; el `manifest.json` de CI usa
  `--channel stable` fijo, asi que en v1 el canal soportado es **stable**.
- **Esquema de estado**: compara el `state_schema` anunciado con el que
  soporta el binario instalado. No publiques una release que requiera una
  transicion sin un plan de cambio y rollback especifico, probado y documentado;
  el importador puntual del corte v1 ya fue retirado.
- **Ventana de procesamiento de npm**: una version recien publicada no es
  instalable de inmediato (escaneo + indice). No confundir con un fallo: el
  `+ climier@X.Y.Z` del publish ya confirmo. En paquetes nuevos puede quedar el
  placeholder `0.0.0-stage`; `latest` es lo que importa.
- **Recuperacion**: si el CI del tag falla en los assets, re-ejecuta el workflow;
  la subida es idempotente (`--clobber`). Si npm ya tiene la version, el script
  aborta solo.

## Referencias

- `.adrs/071-release-local-publish.md` — decision del publish local.
- `scripts/release-plan.ts` — planner de version y CHANGELOG.
- `scripts/release.ts` — corte, gate y publish.
- `README.md` § Release checklist — version resumida para humanos.
