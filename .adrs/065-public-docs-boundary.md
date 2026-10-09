# ADR-065: boundary público/interno y publicación por allowlist con guardrail

- Gate: `G-adr065-public-docs-boundary` · Deriva de: `G-docs-public-site-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

El repositorio es público y un sitio de documentación también lo será. Hoy `docs/` mezcla contrato de producto con material interno (`climier-ui.md` nombra un proyecto real y rutas privadas; `PLUGINS.md` referencia `.adrs`/ADRs y node ids internos; `reference.md` usa node ids internos como ejemplo). Un sitio indexable amplifica cualquier fuga: hay que publicar por construcción, no por corrección. El detalle del problema y las alternativas está en `.decisions/G-docs-public-site-rfc.md`.

## Decisión

La publicación del sitio se gobierna por una **allowlist**, no por una denylist:

1. El contenido público efectivo es exactamente `docs/content/docs/**` más los tres archivos canónicos (`docs/reference.md`, `docs/PLUGINS.md`, `docs/remote-server.md`) en su path actual. Nada más es ruteable ni indexable por el build, el route handler o el índice de búsqueda.
2. `docs/scripts/check-public-docs.mjs` escanea ese contenido público efectivo y **falla cerrado** ante los patrones prohibidos listados abajo. Corre en `ci.yml` **sin filtro de paths** (es un escaneo puro de filesystem) y es gate de deploy.
3. Los tres canónicos se sanean en su lugar: node ids genéricos en `reference.md`; sin refs a `.adrs`/ADRs ni al proceso interno de release en `PLUGINS.md`; sin la sección de cutover de mantenedor ni la invocación E2E interna en `remote-server.md`.
4. **Fuera de alcance:** no se extrae `AGENTS.md`, `.adrs/`, `.decisions/`, `skills/` ni `CLIMIER-CHEATSHEET.md` del repo público. Es una decisión de proceso con alcance mayor; queda como gate follow-up. Esta ADR solo garantiza que el *sitio* no los publica.

Patrones prohibidos (el guardrail debe fallar):

- `vegsport` (case-insensitive) y nombres de cliente/proyecto real.
- IPs privadas/hosts internos: `\b(?:10|127)\.\d+\.\d+\.\d+\b`, `\b192\.168\.\d+\.\d+\b`, `\b100\.\d+\.\d+\.\d+\b`, `agento`, `ubuntu@`, `/home/ubuntu`.
- Proceso interno: `ADR-\d+`, `\.adrs`, `\.decisions`, `\.pi/`, `\.agents/`, `AGENTS\.md`, `CLIMIER-CHEATSHEET`, `skills/`.
- Node ids internos: `\b(?:T|G|K)-(?:re|ui|pg|pf|rar|rb)-[a-z0-9-]+\b`.
- Secretos/config: `CLIMIER_SERVER_PASSWORD`, `\.deploy\.env`, `server\.env` con valores.
- Links relativos a archivos internos del repo.

Patrones permitidos (fixtures que deben pasar): `T-example-*`, `T-auth-*`, `G-auth-*`, `alice`, `./my-project`.

Audiencia primaria: **usuarios del CLI**. v1 completa su recorrido end-to-end (instalación → primer proyecto/task → leer bloqueos y estado); `self-hosting` y `plugins` entran como referencia sin reescritura profunda.

## Consecuencias

- A favor: el sitio no puede publicar material interno aunque el repo siga conteniendo otros archivos internos; el guardrail es barato y determinista.
- En contra / deuda: el repo público sigue exponiendo `AGENTS.md`/`.adrs/`/`.decisions/` a quien mira GitHub (no al sitio). Quien busque confidencialidad real necesita el follow-up. Los patrones son heurísticos: un nombre de cliente no listado no se detecta.

## Plan de implementación

1. **Sanear canónicos** — archivos: `docs/reference.md`, `docs/PLUGINS.md`, `docs/remote-server.md`.
2. **Guardrail + fixtures** — archivos: `docs/scripts/check-public-docs.mjs`, `docs/scripts/check-public-docs.fixtures.ts`.
3. **Wiring de CI** — archivos: `.github/workflows/ci.yml`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el saneo (pieza 1) y el guardrail (pieza 2) son tasks separadas con paths exclusivos; el wiring (pieza 3) depende de la pieza 2 porque el guardrail debe existir antes de invocarse en `ci.yml`. Ambigüedad detectada: el guardrail no debe romper `check-retired-surfaces.ts`, `test/package.test.ts` ni `test/server-setup-docs.test.ts`; el saneo debe correr esos checks.

## Verificación

- `bun run scripts/check-retired-surfaces.ts` y `bun run surface:check` en verde tras el saneo.
- `node --test test/server-setup-docs.test.ts test/package.test.ts` en verde.
- `node docs/scripts/check-public-docs.mjs` pasa sobre el contenido real y falla sobre los fixtures negativos.
- Grep de control: ningún patrón prohibido aparece en el contenido público efectivo.
