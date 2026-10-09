# RFC: Distribucion, versionado y automatizacion de releases de climier

- Gate: `G-release-engineering-rfc` · Iniciativa: `release-engineering` · Estado: aprobado (2026-10-09)
- Autor: orchestrator (Pi) · Fecha: 2026-10-09

## Problema

Evidencia del repo (recon 2026-10-09):

- `package.json`: `version` 2.0.0, `bin.climier = ./bin/climier.ts` con shebang `#!/usr/bin/env bun`, `engines.bun >= 1.4`, sin `engines.node`, `files` incluye `ui/dist`.
- El README promete `npm install -g climier` con **Node 20+** y `npx climier`; el bin es un `.ts` con shebang `bun`. El runtime soportado y la documentacion no coinciden.
- `npm view climier` devuelve 404: el paquete nunca se publico.
- Hay **cero tags git**: el job `release` de `ci.yml` (dispara con `tags: v*`) nunca corrio, asi que no existen GitHub Releases con binarios descargables. `dist/` solo tiene builds locales linux-x64/arm64.
- `--version` no tiene fuente unica: define `CLIMIER_BUILD_VERSION`, si no `npm_package_version`, si no el literal `"2.0.0"` hardcodeado en `src/cli/dispatch.ts:66`. Un bump de `package.json` deja la fuente mintiendo.
- `ui/dist` esta en `.gitignore` pero tambien en `files`: en un checkout limpio el tarball sale **sin la UI** y `climier ui` rompe. `prepublishOnly` no construye la UI.
- No existe `upgrade` en `KNOWN_COMMANDS` ni codigo de update-check.
- Los commits no siguen Conventional Commits: `Merge task T-urls-command`, `Add urls command`, `T-ui-dm-guards`. No hay hooks (`core.hooksPath` sin setear, no existe `.githooks`) ni commitlint.
- El backlog de `v1-launch` tiene `T-launch-install` (instalacion facil) y `T-launch-npm-publish` (blocked-by install), ambas en `backlog` y sin decision tomada.

Consecuencia: no hay forma reproducible de instalar, versionar ni actualizar climier, y sin un contrato de commits no hay automatizacion de release confiable.

## Propuesta

Un modelo unico de distribucion, versionado y release, en cinco decisiones cohesivas:

1. **Runtime y distribucion.** Bun 1.4+ es el unico runtime soportado. Tres canales de distribucion: npm (paquete `climier`, funciona por el shebang `bun`), binarios standalone por plataforma (GitHub Releases, sin runtime) e instalador `curl | sh` que baja el binario con verificacion de checksum. Se reconcilian README, `engines`, shebang y binarios. Windows usa solo el binario, porque el shim de npm asume `node`.
2. **Fuente de version.** `package.json.version` es la unica fuente. Se elimina el define y el fallback hardcodeado; el codigo importa el JSON (`import pkg from "../package.json" with { type: "json" }`), que Bun inlinea en `--compile` y lee vivo desde el paquete instalado. `--version` sigue siendo semver estricto; `climier version --json` expone `{version, channel, distribution, commit, state_schema, platform, bun}`.
3. **Canales.** Dos ejes ortogonales. Release channel (`stable`/`next`) codificado en semver prerelease (`2.2.0-next.1`), espejado en npm dist-tags (`latest`/`next`) y GitHub pre-release. Distribution channel (`binary`/`npm`/`source-link`/`one-off`) detectado en runtime por un define de build.
4. **Manifiesto.** `manifest.json` por release (asset) con `version`, `channel`, `state_schema`, `min_bun`, `notes_url` y `artifacts[<platform>] = {url, sha256, size}`. La URL `releases/latest/download/manifest.json` es el canal `stable` sin hosting propio. Es lo que consume `upgrade --check`.
5. **Contrato de commits.** Conventional Commits con id de nodo del DAG obligatorio al final del subject: `<type>(<scope>)!?: <subject> [<node-id>]`. Hook `commit-msg` versionado en `.githooks/` mas `core.hooksPath`, con la logica testeable en `scripts/check-commit-msg.ts`. Valida formato (local) y existencia del nodo via `climier show <id>` (fail-closed). Escapes: `git commit --no-verify` (salta todo) y `CLIMIER_COMMIT_NO_TASK=1` (salta solo el chequeo contra el DAG).
6. **Automatizacion de release.** `release-please` (release PR) parsea los commits convencionales, abre o actualiza el PR `chore(main): release X.Y.Z` con el CHANGELOG, y al mergear crea el tag `vX.Y.Z` mas el GitHub Release. CI en tag construye binarios y manifiesto y los adjunta al Release; un job `publish-npm` (gateado por `release_created`) construye `ui/dist`, verifica tag==version y publica.
7. **`climier upgrade`.** Deteccion del distribution channel; `binary` descarga, verifica y reemplaza de forma atomica; `npm` delega al package manager; `source-link` no auto-actualiza; `one-off` rechaza. `--check` consulta el manifiesto. El update-check es opt-in, con cache de 24 h y apagado en CI/non-TTY.

## Alternativas consideradas

### A. Runtime

| Opcion | Pros | Contras |
|---|---|---|
| Bun-only, npm via shebang `#!/usr/bin/env bun` (recomendada) | cero build de JS; consistente con la migracion nativa a Bun; `npm i -g` funciona con Bun instalado | requiere Bun 1.4+; `npx` no sirve; Windows por npm roto |
| Build a JS para Node 20+ | `npx`/npm universales, sin Bun | agrega step de build y deuda de compatibilidad; contradice `ts-bun-migration`; doble runtime a testear |
| Solo binarios standalone | sin runtime, instalacion de una linea | sin `npm i -g`, sin dist-tags, actualizacion propia obligatoria |

### B. Automatizacion de release

| Opcion | Pros | Contras |
|---|---|---|
| `release-please` (recomendada) | PR de release trazable; CHANGELOG desde commits convencionales; tag + Release nativos; sin devDependency | exige Conventional Commits (ahora garantizado por el hook); el changelog generado necesita curaduria para la prosa de migracion |
| `semantic-release` | cero pasos humanos | un release por merge a main (el runner mergea por task); requiere historial convencional estricto |
| `changesets` | granularidad por cambio, prosa humana | un changeset por task = friccion con el runner; tag `climier@x.y.z`, no `vX.Y.Z`; devDependency |
| Release PR propio (DAG-driven) | cero deps; notas desde el DAG | mantenimiento propio; release-please ya cubre el caso ahora que los commits son convencionales |

### C. Contrato de commits

| Opcion | Pros | Contras |
|---|---|---|
| Conventional + `[node-id]` con hook (recomendada) | trazabilidad commit→DAG; CHANGELOG automatico; exenciones claras | dependencia de red en el hook (repo remote-linked); requiere cambio en el runner |
| Solo Conventional Commits, id opcional | mas simple | pierde trazabilidad; no valida contra el DAG |
| Trailer `Refs: T-id` en vez de `[T-id]` en el subject | mas maquina-legible (git trailers) | release-please no lo arrastra al CHANGELOG; menos visible |

## Alcance

- Dentro: runtime publicado y reconciliacion de `package.json`/README/shebang; fuente unica de version; canales stable/next; manifiesto + update-check; contrato de commits + hooks + enforcement; automatizacion de release con release-please; CI de publish (build-ui, assertion de version, npm, assets); comando `climier upgrade` y `--check`.
- Fuera: el contenido de `T-launch-landing` y `T-launch-gtm`, y el plugin de Pi; la logica del server remoto (los ADRs 057–059 y `G-server-setup-rfc` ya cubren eso); cambio del contrato `/v1`; cambio del schema de estado (el manifiesto solo reporta `state_schema`).

## Riesgos y open questions

- **El runner no emite commits convencionales.** Dependencia cross-repo (`climier-flow`): sin commits `feat(...) [T-id]` en main, release-please no abre release PR. → Mitigacion: cambiar el runner antes de landear la automatizacion; los merge commits quedan exentos.
- **Hook fail-closed con backend remoto.** Cada commit pega a la red (~0.37 s medido); si el server esta caido no se puede commitear. → Mitigacion: `CLIMIER_COMMIT_NO_TASK=1` y `--no-verify`, con un mensaje que distingue "id no existe" de "DAG inalcanzable".
- **`--no-verify` permite cualquier commit**, incluido uno no-convencional. → Mitigacion: audit no bloqueante en CI, para no matar el escape por diseno.
- **CHANGELOG curado vs generado.** release-please sobrescribe `CHANGELOG.md`. → Mitigacion: editar la prosa en el release PR antes de mergear; la seccion de migracion se mantiene en la entrada del Release.
- **Publish sin UI.** El contenedor de `ui/dist` debe existir en el job de publish. → Mitigacion: paso explicito `build:ui` antes de `pack:check`.
- **Comparacion de prereleases.** `2.2.0-next.1 < 2.2.0`. → Definir en el ADR-061 la regla de seleccion: `stable` = mayor sin prerelease; `next` = mayor incluyendo prereleases.
## Resoluciones de review (2026-10-09)

Bloqueo de ejecucion resuelto:

- Cada ADR baja su plan de implementacion a piezas con path y acceptance propios (ver "ADRs derivados" y los ADR en `.adrs/`).
- La dependencia con el runner es un edge real, no un riesgo: la task cross-repo `T-flow-conventional-commits` cubre los dos caminos (Worker y fallback `validatorCommit`) y bloquea 062/063, con anchors en `climier-flow.config.json`, `flows/climier-flow/nodes/commit/run.js` y `test/flow-nodes.test.js`.

Preguntas resueltas:

1. **Node/`npx` cortados explicitamente.** Runtime soportado: Bun 1.4+. `engines` y README lo declaran; se elimina `npx` de la doc. Nota de migracion para checkouts enlazados.
2. **Windows v1 = solo binario.** Plataformas soportadas = la matriz CI (5 targets). `curl | sh` falla explicito en Windows; instalador PowerShell fuera de v1. Arquitecturas fuera de la matriz: no soportadas.
3. **Sin conexion.** `upgrade --check` falla con `UPDATE_CHECK_UNREACHABLE`, nunca "al dia". Offline = artefacto descargado + checksum manual; `--from <file>` fuera de v1.
4. **Hook fail-closed con escapes.** Formato = local y autoritativo; existencia = remota. Sin credenciales/offline/timeout rechaza con mensaje diferenciado. El audit de CI es no bloqueante por diseno.
5. **Nombres inequivocos.** `release_channel` (`stable`/`next`) y `distribution` (`binary`/`npm`/`source-link`/`one-off`). Manifiesto `next` en tag rodante: `releases/download/next/manifest.json`. Seleccion: `stable` = mayor sin prerelease; `next` = mayor incluyendo prereleases.
6. **Deteccion de `distribution`.** Define `CLIMIER_DISTRIBUTION=binary` en compilados; si no, realpath de `import.meta.url`: `/node_modules/` → `npm`, checkout con `.git` → `source-link`, resto → `one-off`. Prueba por caso en el packed smoke.
7. **Instalador en este repo.** `scripts/install.sh`, servido desde los assets del Release; la landing solo linkea.
8. **Sugerencias adoptadas.** `manifest_version: 1` y politica de evolucion; SHA-256 detecta corrupcion pero **no autentica** (firma = decision futura); tests de `--version` en repo/npm/binario incluyendo `2.2.0-next.1`, relajando el regex del packed smoke.

## Alcance v1 (lanzamiento oficial)

- **La primera release publicada es `v1.0.0`, el lanzamiento oficial.** `package.json` se alinea de `2.0.0` a `1.0.0`; el CHANGELOG ya tiene la entrada `[1.0.0]`.
- Se implementa `stable` completo. Quedan **fuera de v1.0.0**, como follow-ups posteriores: canal `next`, firma de artefactos, notificacion periodica de actualizaciones e instalador PowerShell.

## ADRs derivados (aprobados 2026-10-09)

- [x] ADR-060: Runtime soportado y canales de distribucion → `.adrs/060-runtime-distribution-channels.md`
- [x] ADR-061: Fuente unica de version y canales de release → `.adrs/061-version-source-release-channels.md`
- [x] ADR-062: Contrato de commits, hooks y enforcement → `.adrs/062-commit-contract-hooks.md`
- [x] ADR-063: Automatizacion de release (release-please + CI publish) → `.adrs/063-release-automation.md`
- [x] ADR-064: Comando `climier upgrade` y update-check → `.adrs/064-climier-upgrade.md`
