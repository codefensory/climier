# Documentation site

The site is a static TanStack Start/Fumadocs build. `bun run build` syncs the
canonical Markdown sources, prerenders every document route, and writes the
client-side ZBSearch/Orama-compatible index to `.output/public/api/search`.
There is no search or page-rendering backend.

## Base path

`DOCS_BASE_PATH` is a URL prefix, not a directory. GitHub Pages serves the
artifact with its root mapped onto the served root, so the prefix must match how
the site is published and never describe a folder inside the artifact:

- Custom domain at the root (`climier.dev`): `DOCS_BASE_PATH=/` (what CI uses).
- `github.io` project page (`codefensory.github.io/climier/`): `/climier`, e.g.

```bash
DOCS_BASE_PATH=/climier bun run build
bun run preview
```

The prefix reaches Vite assets, the TanStack Router basepath, prerendered links
and the search index, while Nitro's `baseURL` keeps the artifact root mapped onto
the served root (`index.html` and `docs/` directly inside `.output/public`). The
`github-pages` preset additionally injects a bare `/` route; under a base path it
resolves to `<base>` without the trailing slash, which only yields a redirect, so
the build drops it.

## Custom domain

Settings → Pages already holds `climier.dev`. Two things must still hold:

- DNS at the `climier.dev` nameservers (Cloudflare) must exist and must be
  **DNS only** (proxy disabled), otherwise GitHub Pages cannot verify the domain
  or issue a certificate:
  - `A` on `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
    `185.199.111.153`
  - `AAAA` on `@`: `2606:50c0:8000::153`, `2606:50c0:8001::153`,
    `2606:50c0:8002::153`, `2606:50c0:8003::153`
  - `CNAME` on `www` → `codefensory.github.io`
- "Enforce HTTPS" enabled once the certificate is issued. `.dev` is an
  HSTS-preloaded TLD, so plain HTTP does not work in browsers at all.

No `CNAME` file is needed in the artifact: with a GitHub Actions publishing
source GitHub ignores it and keeps the domain in the repository settings.

## Guardrails

`node scripts/check-pages-artifact.mjs` checks a built artifact for the shape a
deployed site needs: a root `index.html` with assets under the base path, one
file per prerendered route, `api/search`, `.nojekyll`, and no second copy of the
base directory. `node scripts/check-pages-artifact.fixtures.mjs` covers the same
checker with positive and negative fixtures, and `scripts/site-paths.mjs` holds
the base path and route contract shared by the build and both guardrails.
