# Documentation site

The site is a static TanStack Start/Fumadocs build. `bun run build` syncs the
canonical Markdown sources, prerenders every document route, and writes the
client-side ZBSearch/Orama-compatible index to `.output/public/api/search`.
There is no search or page-rendering backend.

GitHub Pages uses the root path by default. Set `DOCS_BASE_PATH` when hosting
under a project path, for example:

```bash
DOCS_BASE_PATH=/climier bun run build
bun run preview
```

The same value is applied to Vite assets, TanStack Router, prerendered links,
and the static search API. Use `DOCS_BASE_PATH=/` (or omit it) for a custom
domain hosted at the root.
