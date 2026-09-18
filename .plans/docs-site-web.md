# Docs site for climier (`web/`)

## Goal

- Goal: G-001 · Status: pending · Budget: 1 session (renderer spike timeboxed to
  30 minutes)

`cd web && bun run build` exits 0 and emits a static site with one page per
public markdown file (count derived from the content manifest; 41 on this working
tree, 40 on a clean checkout — never pinned), where every
manifest slug is reachable from the sidebar and returns HTTP 200 when served —
proven by `node web/scripts/verify-docs-site.mjs` exiting 0.

- Verification: `node web/scripts/verify-docs-site.mjs` exits 0 after
  `cd web && bun run build`; root `npm test` and `npm run pack:check` stay green.
- Deliverables: `web/` subproject (own `package.json`, `vite.config`, content
  manifest, layout, verify script), root `package.json` `test:docs` script,
  `.gitignore` entries, AGENTS.md amendment, CI job.
- Budget: 1 session for the build; the renderer spike is timeboxed to 30 minutes.

## Contract corrections (2026-09-17, found during execution)

Facts that changed between planning and execution; these override the wording in
Steps 3–7 below:

1. **The page count is derived, never pinned.** An earlier draft said "41 pages"
   as a constant. `CLIMIER-CHEATSHEET.md` was deleted in HEAD `06eb64e`
   ("docs: drop CLIMIER-CHEATSHEET.md, skill is the command reference"), and
   `.adrs/022-claim-meta-and-freshness.md` exists on disk but is untracked. Both
   the working tree (41) and a clean checkout (40) must build and verify.
   Therefore: the generator derives its inventory, and both the manifest check and
   the verify script compare *rendered count == manifest count*, instead of
   comparing either against a literal.
2. **Inventory is directory-driven, not a literal path list.** Explicit
   directories `docs/`, `docs/plans/`, `.adrs/`, `.decisions/` (non-recursive
   `*.md`, sorted) are required; `README.md` is required (site index);
   `CHANGELOG.md`, `CLIMIER-CHEATSHEET.md`, `ui/DESIGN.md` are included when
   present and reported as `skipped: not present` when absent. This keeps the site
   correct as ADRs/RFCs are added and as files are dropped.
3. **The `linkForRef`/`bySlug` surface is total, not partial**: unknown slugs and
   paths return `undefined`/`null` rather than throwing, so a page that references
   a deleted document does not break the build.

## Decision (renderer) — 2026-09-17

**Fumadocs on TanStack Start (option A)** wins per the pre-stated rule. Evidence
(spike A, `/tmp/spike-a/REPORT.md`): `bun install` exit 0 (5.5 s, 361 packages),
`bun run build` exit 0 (10.9 s), `node_modules` 270 MB (limit 600 MB), build time
11 s (limit 120 s), out-of-root `dir` accepted, dotdirs `.adrs` (19) and
`.decisions` (9) scanned, no-frontmatter corpus rendered via a schema-function
title shim. Spike D (`/tmp/spike-d/REPORT.md`) is retained as evidence only.

Binding implementation constraints inherited from the spike (Vite 7 vs the docs'
Vite 8 assumptions):

- `@vitejs/plugin-react` must be `^5.2.0` (v6 requires Vite 8).
- `resolve.tsconfigPaths` is Vite-8-only: register explicit `resolve.alias` for
  `@` → `./src` and `collections` → `./.source`.
- Use the synchronous loader shape (`page.data.body/toc/title` from
  `toFumadocsSource()`); the guide's async preload/load example does not apply.
- The site reads the generator's in-root mirror `web/content/` (with generated
  frontmatter titles), not the repo dirs directly: in-root beats out-of-root for
  production, and titles come from the H1 pipeline instead of path defaults.
- **Amendment (during build): the mirror extension is `.md`, not `.mdx`.**
  fumadocs-mdx@15.4.1 hardcodes the parser by extension
  (`filePath.endsWith(".mdx") ? "mdx" : "md"`), ignoring `mdxOptions.format`, and
  the corpus is plain markdown with bare `<id>`/`<json>` placeholders outside code
  spans — MDX parsing can never be safe here. Fumadocs derives URLs from
  path-minus-extension, so slugs are unaffected. Do not "helpfully" flip the
  mirror back to `.mdx`.

## Objective

Give climier a browsable documentation site that renders the markdown already in
the repo (`docs/`, `.adrs/`, `.decisions/`, plus the top-level docs) as a
navigable, searchable site built on TanStack Start — without moving, renaming, or
frontmatter-injecting the source files, and without adding a runtime dependency to
the CLI package.

## Scope

- In scope: new `web/` subproject; a content manifest that owns the public set,
  slugs, titles, and section grouping; sidebar/TOC/search/dark-mode layout;
  auto-linking of the inline `` `path/to/file.md` `` references that currently
  carry all cross-document navigation; a verify script; Tailscale-reachable dev
  server; AGENTS.md + CI wiring.
- Out of scope: changing the CLI (`bin/`, `src/`) in any way; moving
  `docs/`, `.adrs/`, or `.decisions/`; adding frontmatter to existing markdown;
  rendering agent-facing prompts (`.pi/`, `skills/`, `.agents/skills/`,
  `AGENTS.md`); a public deployment or a custom domain; editing the existing
  `ui/` subproject or its dependency tree.

## Verified Context

- No web/docs site exists. `git ls-files | cut -d/ -f1` shows no `web/`; the only
  site tooling in the repo is `ui/vite.config.mjs` (Solid + Tailwind 4, proxies
  `/api` to `127.0.0.1:7373`).
- Public content set is 41 files / ~14k lines: `docs/` 4 + `docs/plans/` 6,
  `.adrs/` 18, `.decisions/` 9, `README.md`, `CHANGELOG.md`,
  `CLIMIER-CHEATSHEET.md`, `ui/DESIGN.md`.
- **Zero frontmatter** in that set; titles are the first-line `# H1`. Only
  `.agents/skills/*` and `.pi/agents/*` have YAML frontmatter (excluded here).
- Exactly **one** markdown link exists across the whole set; everything else
  references files as inline code paths (`` `.adrs/021-plugin-foundation-public-api.md` ``).
- `.adrs`, `.decisions`, `.pi` are dotdirs — excluded by default `**/*.md` globs.
- `fumadocs-core/source/schema` `pageSchema` requires `title: z.string()` (no
  default), so missing frontmatter fails the build. `defineDocs({ dir })` accepts
  any path, including outside the app root; `schema` may be a function receiving
  `ctx.path` (supports a derived default title).
- `fumadocs-ui@16.15.11` / `fumadocs-core@16.15.11` / `fumadocs-mdx@15.4.1`
  (peers: React ^19.2, Tailwind 4, Vite 7/8, plus `satteri`). TanStack Start
  `@tanstack/react-start@1.168.56`, still documented as RC, no first-party MDX;
  Vite plugin API is `tanstackStart()` from `@tanstack/react-start/plugin/vite`
  with `@vitejs/plugin-react` after it.
- `@tanstack/markdown@0.0.15` (alpha, 4.9 KB parser, plain markdown only, no MDX
  evaluation) + `@tanstack/highlight@0.1.0` is the dependency-light alternative.
- `ui/` is the precedent for a self-contained subproject: AGENTS.md rule 1 allows
  it, root `package.json` `files: [bin, src, README.md, CHANGELOG.md, LICENSE]`
  excludes it from the npm tarball, and `test/run-core-tests.mjs` skips only
  `ui-*`-prefixed test files while recursing the rest of `test/`.
- CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run pack:check` on
  push and PR, in both Node 20 and Bun 1.3.14 jobs.
- Local toolchain: node v22.22.3, bun 1.3.14. Tailscale is up at 100.83.90.33;
  port 3000 is already bound by another process; 4400 is free; 7373 is
  `climier ui` (loopback unless `CLIMIER_UI_HOST` is set).
- No test asserts on top-level directory layout or on `docs/` paths other than
  `test/v2-docs.test.mjs`, which only requires `docs/reference.md` to exist and
  README to mention it — both unaffected by a read-only site.

## Assumptions

- The site is a **read-only view**; `docs/`, `.adrs/`, `.decisions/` stay exactly
  where they are, because the `spec-pipeline` skill and gate bodies reference
  those paths.
- The site is served locally behind Tailscale, not published.
- English UI copy; the repo's markdown stays in whatever language it is written
  in (mixed ES/EN today).
- One lockfile for `web/` (bun), mirroring `ui/`'s bun-first scripts.

## Files Involved

- `web/` — Create — the whole subproject (package.json, vite.config.mjs,
  route/layout files, content manifest, scripts/, tsconfig).
- `web/content-manifest.mjs` — Create — single source of truth for the public
  file set, slug mapping, derived titles, and section grouping.
- `web/scripts/verify-docs-site.mjs` — Create — build + page/slug/HTTP assertions.
- `.gitignore` — Modify — add `web/node_modules/`, `web/dist/` (and the tool's
  build dir, e.g. `web/.output/`, `web/.tanstack/`).
- `package.json` — Modify — add `test:docs` script only; no dependency changes.
- `.github/workflows/ci.yml` — Modify — add a `docs` job (bun) running the
  verify script.
- `AGENTS.md` — Modify — extend the `ui/` subproject exception to `web/`, list it
  in the source layout, and note that the docs site is read-only.
- `README.md` — Modify — point at the site (one line) next to the existing
  `docs/reference.md` references on lines 144 and 241.
- `docs/`, `.adrs/`, `.decisions/` — Review only — inputs; must not be edited.

## Ordered Execution Steps

1. **Spike: pick the renderer (A vs D) without touching the repo**
   - Context: the plan's shape depends on whether MDX components are needed. Both
     candidates must be probed against the real content before scaffolding.
   - Files: `/tmp/docs-spike/` (throwaway; nothing under `/home/leobar37/code/climier`).
   - Action: build two throwaway minimal sites — (A) TanStack Start + `fumadocs-mdx`
     with `defineDocs({ dir: '<repo>/docs' })` and a `schema` function defaulting
     `title` from `ctx.path`; (D) TanStack Start + `@tanstack/markdown`, reading
     files from disk in a server function. Record, for each: whether it reads
     sources outside the app root, whether it builds with no frontmatter, whether
     dotdirs (`.adrs`, `.decisions`) are included, installed package count, build
     time, and whether search/TOC come free.
   - End State: a decision note appended to this plan naming A or D, with the
     measured evidence and the losing option's disqualifying measurement.
   - Verification: both spikes either `bun run build` exit 0 or a written reason
     they cannot; `du -sh /tmp/docs-spike/*/node_modules` recorded.
   - Depends on: none.

2. **Scaffold `web/` and prove the network path**
   - Context: the site must be reachable from the user's phone, so the bind
     address is a first-class requirement, not a later fix.
   - Files: `web/package.json`, `web/vite.config.mjs`, `.gitignore`.
   - Action: create the subproject with its own deps and a Vite config setting
     `server.host: true` and `server.port: 4400` (never 3000 — taken). Add the
     `.gitignore` entries. No imports from `ui/` or `src/`.
   - End State: `cd web && bun run dev` serves a hello page that is reachable at
     `http://100.83.90.33:4400/`.
   - Verification: `ss -tlnp | grep 4400` shows `0.0.0.0:4400` (not
     `127.0.0.1`), and `curl -sS -o /dev/null -w '%{http_code}' http://100.83.90.33:4400/` returns 200.
   - Depends on: 1.

3. **Content manifest: public set, slugs, derived titles, sections**
   - Context: the content has no frontmatter and no links, so navigation must be
     generated from an explicit list rather than a glob (globs would silently drop
     `.adrs`/`.decisions`).
   - Files: `web/content-manifest.mjs`.
   - Action: enumerate the 41 paths (or derive them from an explicit directory
     list, then assert the count) with per-file `slug` (e.g. `/reference`,
     `/plugins`, `/adr/021-plugin-foundation-public-api`, `/rfc/<gate-id>`),
     `title` from the first `# H1` (fallback: filename), and `section` (Reference,
     Plans, ADRs, RFCs, Project). Fail loudly on a missing file or an empty title.
   - End State: importing the manifest yields 41 entries, each with a unique slug,
     a non-empty title, and a section.
   - Verification: `node -e "import('./web/content-manifest.mjs').then(m => { if (m.pages.length !== 41) throw new Error('count'); })"` exits 0.
   - Depends on: 2.

4. **Render pages, sidebar, and the link layer**
   - Context: the "make it pretty" work is mostly the link layer — today the
     documents reference each other as inline code paths, so a reader cannot
     navigate the graph.
   - Files: `web/` route/layout files, MDX/remark or post-render transform.
   - Action: one route per manifest slug with sidebar grouped by section,
     prev/next, TOC, search, dark mode; plus a transform that turns inline
     `` `docs/x.md` ``, `` `.adrs/NNN-*.md` ``, and `` `.decisions/G-*.md` `` into
     links to the corresponding manifest slugs when the file is in the public set
     (leave the code formatting intact when it is not).
   - End State: from the index every section and page is reachable in two clicks;
     an ADR path quoted inside `docs/PLUGINS.md` renders as a working link; no page
     shows a dead anchor.
   - Verification: spot-check in a browser through the Tailscale URL; grep the
     built output for `href="/adr/021` and confirm it is present.
   - Depends on: 3.

5. **Verification harness**
   - Context: the repo's rule 3 ("no silent failures") applies to the site; a
     content drift (file renamed, H1 removed) must fail loudly.
   - Files: `web/scripts/verify-docs-site.mjs`, `package.json`.
   - Action: after a production build, assert (a) the build exits 0, (b) the
     generated page count equals the manifest count, (c) every manifest slug
     appears in the output, (d) each page contains a non-empty `<h1>`. Serve the
     output and assert every slug returns 200 (loopback is fine here — this is an
     internal health probe, not a user-facing link). Add root script
     `"test:docs": "node web/scripts/verify-docs-site.mjs"`.
   - End State: `npm run test:docs` exits 0 on a healthy tree and exits non-zero
     when a manifest path is missing (prove it by temporarily renaming one file in
     a scratch copy, not in `docs/`).
   - Verification: `npm run test:docs` exit 0; tampered-input run exit 1.
   - Depends on: 4.

6. **Repo integration and CI**
   - Context: a subproject that is invisible to the repo's rules becomes
     unmaintained, and CLI packaging must stay unchanged.
   - Files: `AGENTS.md`, `.github/workflows/ci.yml`, `README.md`.
   - Action: extend the AGENTS.md `ui/` exception to `web/` (self-contained
     subproject, no CLI deps, verification proportional to blast radius, TDD not
     required inside `web/` but the verify script is mandatory); add `web/` to the
     source layout; add a CI job running `bun install && npm run test:docs`; add a
     one-line README pointer to the site and how to start it.
   - End State: `npm test` and `npm run pack:check` still exit 0; the CI file
     contains a docs job; the npm tarball does not contain `web/`.
   - Verification: `npm test`, `npm run pack:check`, and `npm pack --dry-run --json | grep -c web/` returning 0.
   - Depends on: 5.

7. **Serve and share**
   - Context: the user opens links from other devices; a loopback bind is a
     failure mode, not a detail.
   - Files: `web/package.json` scripts (documented in README/AGENTS.md).
   - Action: document the start command for the dev server and for serving the
     production build (`preview` with `--host`); confirm the bind before sharing.
   - End State: the production build is served on `0.0.0.0:4400` and every one of
     the 41 pages returns 200 from `http://100.83.90.33:4400/`.
   - Verification: `ss -tlnp | grep 4400` shows a wildcard bind; the verify script's
     HTTP pass runs against the Tailscale IP.
   - Depends on: 5.

## Risks and Edge Cases

- **Frontmatter requirement (option A)**: Fumadocs requires `title`; mitigated by
  a `schema` function defaulting it from `ctx.path`, or by deriving it in the
  manifest. Never by editing the source markdown.
- **Sources outside the app root**: reading `../docs` may trip Vite's `fs.allow`
  and the file watcher. Preference order: symlink `web/content/*` → repo dirs, then
  a build-time loader, then copying. Whatever wins must be re-verified after a
  clean `bun install` (not just in a warm cache).
- **Dotdirs silently dropped**: `**/*.md` excludes `.adrs`/`.decisions`. The
  manifest must be an explicit list, and step 5's count assertion is the guard.
- **Dependency weight (option A)**: Fumadocs pulls the MDX toolchain plus
  `satteri`; this is the main argument for option D and the reason step 1 exists.
- **React 19 vs `ui/`'s Solid**: keep `web/` fully separate — no shared
  node_modules, no cross-imports, no hoisting assumptions.
- **Root test-suite coupling**: `test/run-core-tests.mjs` skips only `ui-*` files
  and recurses everything else, so docs-site tests must live under `web/` and be
  invoked by the new `test:docs` script, not by dropping files into `test/`.
- **Lockfile policy**: add exactly one lockfile for `web/` (bun), and do not add
  `web` to the root `package.json` `files` whitelist.
- **Port collisions**: TanStack Start defaults to 3000, which is already bound on
  this machine — pin 4400 in the Vite config so it cannot silently drift.
- **Stale `.plans/` placement**: this plan lives in `.plans/` per the planner
  contract while the repo's committed execution plans live in `docs/plans/`.
  Decide once (see Open Questions) rather than leaving `.plans/` as untracked noise.
- **Link-rewrite false positives**: a path quoted inside a code block is a sample,
  not a reference; the transform must skip fenced blocks.

## Validation Strategy

- `cd web && bun install && bun run build` exits 0.
- `npm run test:docs` exits 0 (manifest count == rendered pages == HTTP-200 pages),
  and exits non-zero against a deliberately tampered manifest.
- `npm test` and `npm run pack:check` remain green at the repo root; `web/` does
  not appear in `npm pack --dry-run`.
- Network check: wildcard bind on 4400 via `ss -tlnp`, then a real 200 from
  `http://100.83.90.33:4400/` for the index and for every manifest slug.
- Manual: open the site from a phone over Tailscale and navigate index → ADR →
  RFC without a 404.

## Open Questions

- **Renderer: A (Fumadocs, pretty out of the box, heavier deps) or D (TanStack
  Markdown, minimal deps, hand-rolled nav)?** Step 1 decides empirically;
  recommendation is A unless the spike's dep count is unacceptable.
- Should the site also render agent-facing documents (`AGENTS.md`, `.pi/`,
  `skills/`, `.agents/skills/`)? Default assumed here: no.
- Does `.plans/` get committed or added to `.gitignore`? The repo commits plans in
  `docs/plans/` but the planner contract requires `.plans/`.
- Does the site later become the canonical home of the docs (i.e. move
  `docs/` into `web/content/`)? Default assumed here: no — read-only view, because
  gate bodies and the spec pipeline reference the current paths.
- Deployment: local Tailscale only, or also GitHub Pages? Default assumed: local only.
- Should `climier ui` gain a `web/`-aware command or link, or stay untouched?
  Default assumed: untouched (out of scope for this plan).

## Execution record — 2026-09-17 (complete)

All steps executed and verified by the orchestrator against live state:

- Renderer: **Fumadocs on TanStack Start** (spike A PASS; spike D PASS but inferior —
  see Decision above). Mirror extension amended to `.md` mid-build (see Amendment).
- `npm run test:docs` → exit 0 (7/7 steps; 41/41 slugs → 200 with non-empty h1;
  unknown route 404). Tamper case (`--manifest` with a renamed path) → exit 1.
- Served site: `0.0.0.0:4400` via hub process `web-preview`; **41/41 manifest
  slugs → 200** over `http://100.83.90.33:4400/` (Tailscale IP, wildcard bind);
  `/api/search?query=BLOCKS` → 200; prev/next wired from manifest order.
- Link layer: compile-time remark plugin (`web/src/lib/remark-linkify.mjs`,
  registered via `source.config.ts` default-export global `mdxOptions` — the
  framework applies the preset itself). Site-wide crawl: 59 content anchors across
  21 pages, zero unknown-path spans linkified; TOC anchors unchanged (46).
  `node --test web/test/links.test.mjs` → 17/17.
- Gates at close: `npm test` → 1372 pass / **0 fail** (baseline had been flaky-red
  with 6–15 fails from a sibling session's in-flight work; final run fully green);
  `npm run pack:check` → 0; `npm pack` tarball contains no `web/` entries;
  `tsc --noEmit` in `web/` → clean.
- Integration edits (all verified pure-addition on my hunks): `AGENTS.md` (web/
  tree entry, subproject-exception sentence, test:docs bullet), `.github/workflows/
  ci.yml` (`docs-site` job), `README.md` (two site pointers), `.gitignore`
  (web artifacts), `package.json` (`test:docs` script only).
- Deliberate non-action: **no git commits** — the checkout carries a sibling
  session's uncommitted ADR-022 work in the same files (AGENTS.md, README.md);
  committing would entangle it, and no commit was requested.
