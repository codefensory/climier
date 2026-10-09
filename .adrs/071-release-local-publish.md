# ADR-071: Publicacion local en npm y recorte del release automation

- Gate: `G-adr071-release-local-publish` · Enmienda: ADR-063 (no lo complementa: lo supersede) · Estado: borrador
- Fecha: 2026-10-09

## Contexto

ADR-063 decidio "publicacion solo desde CI" con release-please + el job
`publish-npm` y un `NPM_TOKEN` de larga vida. Ese camino quedo bloqueado: el
publish de CI fallo dos veces con `Two-factor authentication or granular access
token with bypass 2fa enabled is required to publish packages`, porque npm solo
acepta publicar con 2FA interactivo o con un token granular con Bypass 2FA, y el
token del repositorio no lo tiene. En el mismo movimiento npm revoco los classic
tokens (dic-2025) y anuncio que en ene-2027 los tokens con bypass pierden el
publish directo en favor de Trusted Publishing (OIDC), que no puede crear la
primera version.

Estado observado: el tag `v1.0.0` existe en `7572b81` y su GitHub Release ya
tiene los 5 binarios, `manifest.json` y `SHA256SUMS`; `npm view climier` sigue
en 404. Una sesion local (`npm login` + OTP) publica donde un token de CI no
puede, y el operador ya tiene esa sesion en su maquina.

## Decision

1. **`npm publish` es un paso local del operador**, ejecutado por
   `bun run release` (`scripts/release.ts`). Requiere una sesion npm interactiva
   con 2FA, nunca un secreto de repositorio.
2. **El script es dueño del corte**: valida precondiciones (arbol limpio,
   branch `main`, HEAD pusheado, `package.json.version` = tag = seccion del
   CHANGELOG, sesion npm activa), corre el gate (`build:ui`, `typecheck`, `test`,
   `surface:check`, `lint:cut`, `pack:check`, `smoke:pack`), crea y pushea el tag
   `vX.Y.Z`, publica con `npm publish --access public --tag <latest|next>` y
   verifica con `npm view`. `--dry-run` corre todo menos el push del tag y el
   publish real.
3. **CI conserva la verificacion y los binarios cross-platform.** `ci.yml` sigue
   corriendo los checks y, en un tag `v*`, la matriz de 5 targets que genera
   `manifest.json` y `SHA256SUMS`; el job de assets crea el Release si no existe
   y luego sube los archivos. Esto reemplaza a release-please como creador del
   Release.
4. **Se retira `.github/workflows/release.yml`** (release-please y
   `publish-npm`) y el secret `NPM_TOKEN`. El CHANGELOG lo cura el operador en
   el commit de release.
5. **Bootstrap v1.0.0**: el publish de npm sale del tag congelado `v1.0.0`
   (HEAD == commit del tag, sin mover el tag). `1.0.1+` salen de `main`.
6. **Volver a publicar desde CI queda como opcion documentada**: requiere npm
   Trusted Publishing (OIDC) contra un workflow con `id-token: write`, recien
   despues de que exista la primera version. No se implementa en esta decision.

## Consecuencias

- A favor: desbloquea el bootstrap sin tokens de larga vida; el corte queda
  auditable en un solo script; CI mantiene la cobertura que solo CI puede dar
  (binarios darwin/windows que no se pueden smoke-testear desde Linux).
- En contra / deuda: el publish es manual y depende de la maquina y el 2FA del
  operador; no hay provenance/attestation hasta adoptar OIDC; se pierde el
  release PR/CHANGELOG automatico; el corte puede quedar a medias (tag pusheado y
  npm pendiente), asi que el runbook debe fijar el orden y la recuperacion.

## Plan de implementacion

1. **Script de release local** — archivos: `scripts/release.ts`,
   `test/release-script.test.ts`, `package.json`.
2. **Recorte de CI** — archivos: `.github/workflows/release.yml` (borrar),
   `.github/workflows/ci.yml`.
3. **Documentar el corte y el bootstrap** — archivos: `README.md`,
   `docs/reference.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths, comportamiento y acceptance por pieza.

## Verificacion

- `bun run release --dry-run` sobre un arbol limpio en el commit de release
  corre el gate, imprime el plan, no pushea tag ni publica.
- El script falla con mensaje claro ante: arbol sucio, HEAD no pusheado, tag
  existente en otro commit, version != tag, CHANGELOG sin la seccion, sesion npm
  ausente.
- En un tag `v*`, `ci.yml` construye los 5 binarios, genera `manifest.json` y
  `SHA256SUMS`, crea el Release si falta y sube los assets.
- `npm view climier version` devuelve la version publicada y coincide con
  `git tag -l` y `gh release view`.
