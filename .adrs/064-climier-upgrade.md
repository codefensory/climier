# ADR-064: Comando `climier upgrade` y update-check

- Gate: `G-adr064-upgrade` · Deriva de: `G-release-engineering-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

No existe `upgrade` en `KNOWN_COMMANDS` ni codigo de update-check. El manifiesto (ADR-061) y los artefactos publicados (ADR-063) son la fuente que el actualizador necesita, pero `upgrade` debe comportarse distinto segun como se instalo climier. El runner y los agentes usan el binario estable, asi que un upgrade en medio de una ejecucion es peligroso.

## Decision

- **`climier upgrade`** es una operacion de operador; no muta el DAG y no requiere `--as`.
- **Deteccion de `distribution`:** define `CLIMIER_DISTRIBUTION=binary` en compilados; si no, realpath de `import.meta.url`: contiene `/node_modules/` → `npm`; checkout con `.git` → `source-link`; resto → `one-off`.
- **Comportamiento por canal:**
  - `binary`: descarga del manifiesto, **verifica SHA-256**, reemplaza de forma atomica sobre `process.execPath` (temp + `rename`); en Windows usa swap `.old`.
  - `npm`: delega al package manager dueño (`bun add -g climier@latest` / `npm i -g climier@latest`); nunca edita `node_modules` a mano.
  - `source-link`: no auto-actualiza; imprime instrucciones de git.
  - `one-off`: rechaza con mensaje claro.
- **`--check`:** compara contra el manifiesto. Sin red → falla con `UPDATE_CHECK_UNREACHABLE`, **nunca** “al dia”.
- **`--version X`:** permite fijar version (upgrade o downgrade explicito), indispensable porque un binario nuevo no lee formas viejas de estado.
- **`state_schema`:** si el manifiesto declara un `state_schema` mayor, se avisa antes de reemplazar y se indica `climier migrate`.
- **Seguridad operativa:** se niega si hay una ejecucion de Flow activa (lock presente).
- **Update-check periodico:** opt-in, cache de 24 h, apagado en `CI=1`/non-TTY/`CLIMIER_NO_UPDATE_CHECK=1`; solo notifica, nunca aplica. Fuera de v1.0.0.

## Consecuencias

- A favor: actualizacion reproducible y verificada; el canal npm delega en el PM en vez de pelear con el; el downgrade explicito es una salida real ante una release mala.
- En contra / deuda: la deteccion de canal puede clasificar mal en instalaciones exoticas (symlinks, ejecucion desde checkout), mitigado con pruebas por caso; la notificacion periodica queda postergada.

## Plan de implementacion

1. **Comando `climier upgrade`** — archivos: `src/cli/commands/upgrade.ts` (nuevo), `src/cli/dispatch.ts`, `test/upgrade.test.ts` (nuevo).
2. **Cliente de manifiesto** — archivos: `src/upgrade/manifest-client.ts` (nuevo), `test/manifest-client.test.ts` (nuevo).
3. **Reemplazo atomico por canal** — archivos: `src/upgrade/install.ts` (nuevo), `test/upgrade-install.test.ts` (nuevo).
4. **Deteccion de distribucion (define + realpath)** — archivos: `scripts/build-binary.ts`, `src/upgrade/distribution.ts` (nuevo), `scripts/smoke-packed.ts`.
5. **Documentar upgrade, downgrade y offline** — archivos: `README.md`, `docs/reference.md`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths y acceptance por pieza.

## Verificacion

- Con un manifiesto de prueba servido localmente: `upgrade --check` reporta la version nueva; sin red falla con `UPDATE_CHECK_UNREACHABLE`.
- `upgrade` desde un binario descarga, verifica sha256 y reemplaza; un sha incorrecto aborta sin escribir.
- `upgrade` en una instalacion npm invoca el PM correcto; en `source-link` imprime instrucciones y no toca archivos; en `one-off` rechaza.
- `upgrade --version <anterior>` baja de version; con un Flow run activo, `upgrade` se niega.
- El packed smoke clasifica correctamente `npm`; el binario compilado clasifica `binary`; un checkout clasifica `source-link`.
