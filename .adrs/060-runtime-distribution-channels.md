# ADR-060: Runtime soportado y canales de distribucion

- Gate: `G-adr060-runtime-distribution` · Deriva de: `G-release-engineering-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

`package.json` publica `bin.climier = ./bin/climier.ts` con shebang `#!/usr/bin/env bun` y solo declara `engines.bun >= 1.4`, mientras el README promete Node 20+ y `npx climier`. El paquete nunca se publico (npm 404) y no hay tags ni Releases con binarios. CI ya compila binarios por plataforma (`scripts/build-binary.ts`, 5 targets) pero el job solo corre en tags que no existen. `ui/dist` esta gitignoreado y el tarball limpio sale sin UI.

## Decision

- **Bun 1.4+ es el unico runtime soportado.** Se elimina la promesa de Node 20+ y `npx` del README; `engines` declara `bun` y no se usa `engines.node`.
- **Tres canales de distribucion**, con npm como principal:
  - **npm**: paquete `climier`; el bin `.ts` se ejecuta por su shebang `bun` (requiere Bun instalado).
  - **binarios standalone**: `climier-<platform>` desde GitHub Releases, sin runtime. Plataformas soportadas = matriz CI: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`.
  - **instalador**: `scripts/install.sh` en este repo, servido desde los assets del Release; detecta plataforma, descarga el binario, verifica SHA-256 y lo instala en `~/.local/bin` (override `$CLIMIER_INSTALL_DIR`). En Windows falla explicito con instrucciones de descarga manual.
- **Windows en v1 es solo binario.** No se soporta `npm i -g` (el shim de npm asume `node`) ni un instalador PowerShell.
- Un define de build `CLIMIER_DISTRIBUTION=binary` marca los compilados; el resto se clasifica por realpath de `import.meta.url` (detalle en ADR-064).

## Consecuencias

- A favor: un solo runtime, sin build de JS; instalacion de una linea por plataforma; `npm i -g` funciona donde hay Bun.
- En contra / deuda: usuarios de Node/`npx` deben instalar Bun o bajar el binario; firma de artefactos fuera de v1 (SHA-256 solo detecta corrupcion, no autentica); instalador PowerShell postergado.

## Plan de implementacion

1. **Reconciliar runtime y empaquetado** — archivos: `package.json`, `README.md`, `bin/climier.ts`, `bin/climier-server.ts`, `test/package.test.ts`.
2. **Marcar distribucion en compilados** — archivos: `scripts/build-binary.ts`, `src/cli/dispatch.ts`, `test/version.test.ts`.
3. **Publicar binarios y checksums en el Release** — archivos: `.github/workflows/ci.yml`, `scripts/manifest.ts` (compartido con ADR-061).
4. **Instalador** — archivos: `scripts/install.sh` (nuevo), `test/install-script.test.ts` (nuevo).
5. **Documentar plataformas y rutas** — archivos: `README.md`, `docs/reference.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths y acceptance por pieza.

## Verificacion

- `bun run build:binary -- --target bun-linux-x64 --output-dir /tmp/b` produce `climier-linux-x64`; `climier version --json` reporta `distribution: "binary"`.
- `scripts/install.sh` en una maquina limpia instala y `climier --version` responde; un checksum incorrecto aborta sin escribir.
- En Windows el instalador sale con codigo distinto de cero y mensaje accionable.
- README no menciona `npx` ni Node; `bun pm pack` y `bun run smoke:pack` verdes, con `ui/dist` presente en el tarball.
