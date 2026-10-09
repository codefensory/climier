# ADR-061: Fuente unica de version y canales de release

- Gate: `G-adr061-version-channels` · Deriva de: `G-release-engineering-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

`src/cli/dispatch.ts:66` resuelve la version con tres fuentes: el define `CLIMIER_BUILD_VERSION`, si no `process.env.npm_package_version`, si no el literal `"2.0.0"`. Un bump de `package.json` deja la fuente mintiendo. No existe `climier version` ni ningun contrato de canal. El packed smoke exige `--version` con regex `/^\d+\.\d+\.\d+$/`, que rechazaria una prerelease valida.

## Decision

- **`package.json.version` es la unica fuente.** `dispatch.ts` importa `../package.json` con `{ type: "json" }`; se eliminan el define `CLIMIER_BUILD_VERSION` y el fallback `"2.0.0"`. Bun inlinea el import en `--compile` (probado: la version queda congelada por build) y lo lee vivo desde el paquete instalado.
- **`--version` sigue siendo semver estricto** (contrato plain-text). Se agrega `climier version --json` con `{version, release_channel, distribution, commit, state_schema, manifest_version, platform, bun}`.
- **Dos ejes ortogonales**, con nombres inequivocos:
  - `release_channel`: `stable` (sin prerelease) · `next` (prerelease `X.Y.Z-next.N`).
  - `distribution`: `binary` · `npm` · `source-link` · `one-off` (regla en ADR-064).
- **Seleccion de version:** `stable` = mayor version sin prerelease; `next` = mayor incluyendo prereleases. `next` vive en un tag rodante `next`: `releases/download/next/manifest.json`.
- **Manifiesto por release** (`manifest.json`, asset), con `manifest_version: 1`, `version`, `release_channel`, `state_schema`, `min_bun`, `notes_url` y `artifacts[<platform>] = {url, sha256, size}`. URL stable: `releases/latest/download/manifest.json`.
- **v1.0.0:** `package.json` se alinea de `2.0.0` a `1.0.0`; la primera release publicada es `v1.0.0`. En v1.0.0 solo se implementa `stable`.

## Consecuencias

- A favor: una sola fuente de version; `--version` deja de mentir; el manifiesto es la fuente machine-readable de canal y artefactos.
- En contra / deuda: `manifest_version` introduce un contrato nuevo que hay que versionar; SHA-256 no autentica artefactos si se compromete el origen; `next` queda documentado pero sin implementar en v1.

## Plan de implementacion

1. **Fuente unica de version** — archivos: `src/cli/dispatch.ts`, `test/version.test.ts`, `scripts/build-binary.ts` (quitar el define).
2. **`climier version --json`** — archivos: `src/cli/commands/version.ts` (nuevo), `src/cli/dispatch.ts`, `test/version.test.ts`.
3. **Manifiesto** — archivos: `scripts/manifest.ts` (nuevo), `test/manifest.test.ts` (nuevo).
4. **Alinear v1.0.0** — archivos: `package.json`, `CHANGELOG.md`, `.release-please-manifest.json` (este ultimo lo crea ADR-063).
5. **Relajar el regex del smoke** — archivos: `scripts/smoke-packed.ts`.
6. **Documentar canales y contrato de version** — archivos: `README.md`, `docs/reference.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths y acceptance por pieza.

## Verificacion

- `bun bin/climier.ts --version` devuelve el valor de `package.json.version`; un bump de `package.json` se refleja sin tocar codigo.
- El binario compilado devuelve la version congelada del build y `distribution: "binary"`.
- `climier version --json` expone los 8 campos; `2.2.0-next.1` es aceptado por el packed smoke.
- `scripts/manifest.ts` genera un manifiesto valido con `manifest_version: 1` y sha256 por artefacto.
