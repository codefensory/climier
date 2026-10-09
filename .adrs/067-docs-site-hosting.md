# ADR-067: hosting estático, build prerenderizado y búsqueda del sitio de docs

- Gate: `G-adr067-docs-site-hosting` · Deriva de: `G-docs-public-site-rfc` · Estado: aprobado
- Fecha: 2026-10-09

## Contexto

El objetivo es publicar el sitio. Hoy no existe ningún workflow ni destino de deploy de docs: `ui.yml` solo corre Storybook y `.deploy.env` apunta únicamente a `ui/dist` del server. La elección de hosting condiciona el modo de render y el de búsqueda. El reviewer de arquitectura además señaló que copiar `ui.yml` (paths filtrados) no crea un gate de deploy y que cambios en el guardrail o en la configuración del paquete podrían no disparar verificación. Contexto en `.decisions/G-docs-public-site-rfc.md`.

## Decisión

1. **Render:** export **estático (SSG) prerenderizado**. No hay runtime de servidor. El build genera HTML por ruta más assets.
2. **Búsqueda:** índice **Orama estático** generado en build y consumido en cliente (`fumadocs-core/search/client`). No se usa `fumadocs-core/search/server` (`createFromSource`) porque requiere runtime de servidor.
3. **Hosting:** **GitHub Pages** sobre el repo existente (`codefensory/climier`), cero infraestructura nueva. `basePath` configurable para soportar project pages (`/climier/`) y un dominio propio futuro. Un cambio a Cloudflare/Netlify Pages o dominio propio no altera esta arquitectura (sigue siendo estático).
4. **CI y deploy:**
   - `ci.yml` ejecuta `check-public-docs.mjs` **sin filtro de paths** (filesystem puro), para que cambios en el script, el workflow, `docs/package.json` o el lockdown disparen verificación.
   - `docs.yml` (nuevo) corre en `pull_request`/`push` con paths `docs/**` **y** `.github/workflows/docs.yml`: typecheck + build + prerender + guardrail + fixtures.
   - El deploy a Pages ocurre **solo en `push` a `main`** y **solo si** el guardrail y el build pasan. El guardrail es gate de deploy.
5. **Responsable de secretos/dominio:** no hay secretos para Pages (usa el `GITHUB_TOKEN`); un dominio propio requiere configuración del owner. Se documenta en `README`/`CONTRIBUTING`.

## Consecuencias

- A favor: publicación reproducible y barata, sin servidor; el sitio es cacheable y archivable; el deploy no puede publicar contenido que el guardrail rechace.
- En contra / deuda: la búsqueda estática no tiene ranking server-side ni analytics; el índice se reconstruye en cada build. Project pages exigen `basePath` correcto o los assets rompen. GitHub Pages no ofrece previews por PR (se acepta: el build+guardrail sí corren en PR).

## Plan de implementación

1. **Build estático + prerender** — archivos: `docs/vite.config.ts`, `docs/package.json` (`build`/`prerender` scripts), `docs/src/routes/**`.
2. **Búsqueda estática** — archivos: `docs/src/routes/api/search.ts` (o builder estático), `docs/src/lib/search.ts`.
3. **Workflow de docs** — archivos: `.github/workflows/docs.yml`.
4. **Guardrail en CI sin filtro** — archivos: `.github/workflows/ci.yml`.
5. **Deploy a Pages** — archivos: `.github/workflows/docs.yml` (job de deploy con `actions/deploy-pages`), `docs/vite.config.ts` (`basePath`).

## Onboarding breve para crear tasks

- [x] Onboarding realizado — build/prerender (1) y búsqueda (2) comparten `docs/**` con el scaffold y el contenido; conviene que el build quede en una task temprana y la búsqueda como task propia posterior. El workflow (3) y el deploy (5) comparten archivo → misma task o secuencia explícita. Ambigüedad: el `basePath` real de Pages se confirma al activar Pages en el repo; la task de deploy debe dejar el valor configurable y documentado.

## Verificación

- `cd docs && bun run build` produce salida estática por ruta (HTML presente) y un índice de búsqueda.
- `bun run preview` sirve el sitio y una query de búsqueda devuelve resultados sin backend.
- PR que introduce un patrón prohibido en `docs/content/docs/**` **falla** por el guardrail en CI.
- Push a `main` con guardrail y build verdes publica en Pages; un PR no publica.
- Los assets resuelven bajo el `basePath` configurado (project page o dominio propio).
