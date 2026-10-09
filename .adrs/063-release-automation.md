# ADR-063: Automatizacion de release (release-please + CI publish)

- Gate: `G-adr063-release-automation` · Deriva de: `G-release-engineering-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

No hay tags git, asi que el job `release` de `ci.yml` (tags `v*`) nunca corrio: no existen Releases ni binarios descargables, y `climier` no esta en npm (404). `prepublishOnly` corre tests pero no construye `ui/dist`, que esta gitignoreado y en `files`. La publicacion a npm no existe en CI. Con el contrato de commits (ADR-062) y la fuente unica de version (ADR-061) resueltos, es posible automatizar el release desde PRs.

## Decision

- **`release-please`** con `release-please-config.json` (`release-type: node`, `include-v-in-tag: true`, `changelog-sections`) y `.release-please-manifest.json`. Un push a `main` abre/actualiza el PR `chore(main): release X.Y.Z` con el CHANGELOG generado desde los commits convencionales; la prosa de migracion se edita en ese PR antes de mergear.
- **Al mergear el release PR, release-please crea el tag `vX.Y.Z` y el GitHub Release.** No se usa `skip-github-release` (evita el bug conocido de que se saltea el tag).
- **CI en tag (`v*`)**: construye los 5 binarios + `manifest.json` + `SHA256SUMS` y los **adjunta al Release ya creado** (upsert, p. ej. `softprops/action-gh-release`).
- **Job `publish-npm`, gateado por `release_created`**: construye `ui/dist`, corre el gate, **verifica `tag == package.json.version`** y publica con `--tag latest` (o `next` si la version es prerelease).
- **Bootstrap v1.0.0:** `package.json` alineado a `1.0.0`; el primer tag `v1.0.0` es el lanzamiento oficial y se corta una sola vez como bootstrap; `.release-please-manifest.json` arranca en `1.0.0` y release-please toma el control para `1.1.0+`.
- **Publicacion solo desde CI.** Nunca `npm publish` local; se elimina esa posibilidad de la doc.

## Consecuencias

- A favor: release PR trazable y revisable; CHANGELOG desde commits; tag + Release + npm + binarios + manifiesto en un solo camino reproducible; se corrige el tarball sin UI.
- En contra / deuda: depende de Conventional Commits (ADR-062) y del cambio del runner; release-please reescribe `CHANGELOG.md` y exige curaduria; `NPM_TOKEN` es un secret de larga vida.

## Plan de implementacion

1. **Config de release-please** — archivos: `release-please-config.json` (nuevo), `.release-please-manifest.json` (nuevo).
2. **Workflow de release** — archivos: `.github/workflows/release.yml` (nuevo).
3. **Publish npm** — archivos: `package.json` (script `build:ui`, `prepublishOnly` con UI + assertion de version), `.github/workflows/release.yml`.
4. **Assets del Release** — archivos: `.github/workflows/ci.yml`, `scripts/manifest.ts`.
5. **Bootstrap v1.0.0** — archivos: `package.json`, `CHANGELOG.md`, tag `v1.0.0`.
6. **Documentar el runbook de release** — archivos: `README.md`, `docs/reference.md`, `CONTRIBUTING.md` (si no existe, seccion en README).

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths y acceptance por pieza; el orden esta fijado por las dependencias.

## Verificacion

- Un push a `main` con commits convencionales abre un release PR con CHANGELOG; mergearlo crea el tag y el Release.
- El job `publish-npm` falla si `tag != package.json.version` y publica si coinciden; `npm view climier version` devuelve la version.
- El tarball publicado contiene `ui/dist` y `climier ui` arranca; `gh release view vX.Y.Z` lista binarios, `manifest.json` y `SHA256SUMS`.
- `curl -sL .../releases/latest/download/manifest.json` devuelve el manifiesto de la ultima stable.
