#!/usr/bin/env node
/**
 * gen-content.mjs — tool-agnostic content pipeline for the `web/` docs site.
 *
 * Reads the public docs set from the repo working tree (read-only inputs) and
 * writes the two artifact families every renderer candidate consumes:
 *
 *   web/content.generated.json   machine index: pages + sections
 *   web/content/<page>.md       one markdown mirror per page (frontmatter + body),
 *                                nested to mirror the slug: index.md, reference.md,
 *                                plans/<base>.md, adr/<base>.md, rfc/<base>.md
 *                                (plain markdown: the corpus has bare `<id>` text)
 *   web/content/meta.json        fumadocs sidebar: root order of top-level entries
 *   web/content/<dir>/meta.json  fumadocs sidebar: one per content directory
 *
 * The inventory is DERIVED from the tree (explicit top-level files + non-recursive
 * `*.md` scans of the doc directories) so it stays correct as ADRs/RFCs/plans are
 * added or removed. Nothing here is pinned to a page count.
 *
 * Output is byte-identical across runs: stable key order, no timestamps.
 *
 * Node ESM, zero dependencies. Run: `node web/scripts/gen-content.mjs`
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(WEB_DIR, "..");
const CONTENT_DIR = join(WEB_DIR, "content");
const INDEX_FILE = join(WEB_DIR, "content.generated.json");

/** Sidebar title of the root fumadocs meta.json. */
const ROOT_META_TITLE = "climier docs";

/**
 * Top-level docs. `required` entries abort the run when the file is not on disk;
 * the others are optional so the pipeline survives a file being dropped upstream
 * (CLIMIER-CHEATSHEET.md was deleted in commit 06eb64e — its content now lives in
 * skills/climier/references/commands.md). Absent optional files are reported in
 * the summary as `skipped:`, never silently.
 * `order` here is the presentation order of the `project` section.
 */
const TOP_LEVEL = [
  { path: "README.md", slug: "/", section: "overview", required: true },
  { path: "CHANGELOG.md", slug: "/changelog", section: "project", required: true },
  { path: "CLIMIER-CHEATSHEET.md", slug: "/cheatsheet", section: "project", required: false },
  { path: "ui/DESIGN.md", slug: "/ui-design", section: "project", required: true },
];

/**
 * Directories scanned one level deep for `*.md` pages. All are required: a missing
 * doc directory means the checkout is wrong, not that the docs set shrank.
 *  - slug(base) maps a file basename to its page slug (frozen slug table)
 *  - sort: "name" (code-unit order) or "number" (numeric filename prefix)
 *  - first: names forced to the front of the section, in the given order
 *    (docs/reference.md is the canonical reference page)
 */
const DIRECTORIES = [
  { dir: "docs", section: "reference", slug: (base) => `/${base.toLowerCase()}`, sort: "name", first: ["reference.md"] },
  { dir: "docs/plans", section: "plans", slug: (base) => `/plans/${base}`, sort: "name" },
  { dir: ".adrs", section: "adrs", slug: (base) => `/adr/${base}`, sort: "number" },
  { dir: ".decisions", section: "rfcs", slug: (base) => `/rfc/${base}`, sort: "name" },
];

/** Section registry, in site order. `order` only ranks sections; page `order` is
 *  the page's 0-based index inside its section. */
const SECTIONS = [
  { id: "overview", title: "Overview", order: 0 },
  { id: "reference", title: "Reference", order: 10 },
  { id: "plans", title: "Plans", order: 20 },
  { id: "adrs", title: "ADRs", order: 30 },
  { id: "rfcs", title: "RFCs", order: 40 },
  { id: "project", title: "Project", order: 50 },
];

/** `##`/`###` only: the nav index, not a full document outline. */
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;
const TITLE_RE = /^#\s+(.+?)\s*$/;

function fail(message) {
  throw new Error(`gen-content: ${message}`);
}

/** Marks every line that opens, lives inside, or closes a fenced code block. */
function fencedMask(lines) {
  const fenced = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open) {
      fenced[i] = true;
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length) open = null;
      continue;
    }
    if (fence) {
      open = { char: fence[1][0], length: fence[1].length };
      fenced[i] = true;
    }
  }
  return fenced;
}

/** Kebab-case anchor id; unicode letters/digits survive, everything else collapses. */
function kebab(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePage(relPath) {
  let raw;
  try {
    raw = readFileSync(join(REPO_ROOT, relPath), "utf8");
  } catch (cause) {
    fail(`cannot read ${relPath}: ${cause.message}`);
  }
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const fenced = fencedMask(lines);

  let titleIndex = -1;
  let title = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const match = TITLE_RE.exec(lines[i]);
    if (match) {
      titleIndex = i;
      title = match[1].replace(/\s+#+\s*$/, "").trim();
      break;
    }
  }
  if (titleIndex === -1) fail(`${relPath}: no H1 title (expected a line matching /^#\\s+(.+)$/)`);

  const headings = [];
  const seen = new Map();
  for (let i = titleIndex + 1; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const text = match[2].trim();
    const base = kebab(text);
    const hits = (seen.get(base) ?? 0) + 1;
    seen.set(base, hits);
    headings.push({ depth: match[1].length, text, id: hits === 1 ? base : `${base}-${hits - 1}` });
  }

  const bodyLines = lines.slice(titleIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
  const body = bodyLines.join("\n").replace(/\s+$/, "");

  return { title, headings, body };
}

/**
 * Emitted page extension. The mirror is plain markdown, and fumadocs-mdx picks its
 * parser from the extension alone (`filePath.endsWith(".mdx") ? "mdx" : "md"` in
 * fumadocs-mdx@15 — `mdxOptions.format` cannot override it). The corpus contains bare
 * `<id>`/`<json>` placeholders and braces outside code spans, which the MDX parser
 * rejects as unclosed JSX, so `.md` is the only format-safe choice.
 */
const PAGE_EXT = ".md";

/**
 * Page path inside web/content/, mirroring the contract slug: `/` -> index.md,
 * `/reference` -> reference.md, `/adr/021-x` -> adr/021-x.md. Fumadocs derives the
 * URL from the path minus the extension, so with `baseUrl: '/'` these paths resolve
 * to exactly the contract slugs.
 */
function pagePathFor(slug) {
  return `${slug === "/" ? "index" : slug.slice(1)}${PAGE_EXT}`;
}

/** Same page path without the extension: the name meta.json entries refer to. */
function pageNameFor(slug) {
  return pagePathFor(slug).slice(0, -PAGE_EXT.length);
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderPage(page) {
  const title = page.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\ntitle: "${title}"\n---\n\n${page.body}\n`;
}

/**
 * Writes the fumadocs sidebar manifests: a root meta.json listing top-level entries
 * in site order, plus one meta.json per content directory (plans/, adr/, rfc/) listing
 * its page bases in contract order.
 */
function emitMeta(pages) {
  const rootEntries = [];
  const byDirectory = new Map();

  for (const page of pages) {
    const path = pageNameFor(page.slug);
    const slash = path.indexOf("/");
    const dir = slash === -1 ? null : path.slice(0, slash);
    const entry = dir ?? path;
    if (!rootEntries.includes(entry)) rootEntries.push(entry);
    if (dir === null) continue;
    if (!byDirectory.has(dir)) byDirectory.set(dir, []);
    byDirectory.get(dir).push(page);
  }

  writeFileSync(join(CONTENT_DIR, "meta.json"), jsonFile({ title: ROOT_META_TITLE, pages: rootEntries, root: true }));

  for (const [dir, members] of byDirectory) {
    const sectionTitles = new Set(members.map((page) => page.section));
    if (sectionTitles.size > 1) fail(`content directory "${dir}/" mixes sections: ${[...sectionTitles].join(", ")}`);
    const section = SECTIONS.find((candidate) => candidate.id === members[0].section);
    mkdirSync(join(CONTENT_DIR, dir), { recursive: true });
    writeFileSync(
      join(CONTENT_DIR, dir, "meta.json"),
      jsonFile({
        title: section.title,
        pages: members.map((page) => pageNameFor(page.slug).slice(dir.length + 1)),
      }),
    );
  }
}

function emit(index) {
  rmSync(CONTENT_DIR, { recursive: true, force: true });
  mkdirSync(CONTENT_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, jsonFile(index));
  for (const page of index.pages) {
    const target = join(CONTENT_DIR, pagePathFor(page.slug));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPage(page));
  }
  emitMeta(index.pages);
}

function collectInventory() {
  const missing = [];
  const skipped = [];
  const entries = [];

  for (const doc of TOP_LEVEL) {
    if (statSync(join(REPO_ROOT, doc.path), { throwIfNoEntry: false })?.isFile()) {
      entries.push({ path: doc.path, slug: doc.slug, section: doc.section });
    } else if (doc.required) {
      missing.push(doc.path);
    } else {
      skipped.push(doc.path);
    }
  }

  for (const source of DIRECTORIES) {
    const absolute = join(REPO_ROOT, source.dir);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      missing.push(`${source.dir}/`);
      continue;
    }
    const bases = readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length));
    const pinned = (source.first ?? []).map((name) => name.replace(/\.md$/, ""));
    const rank = (base) => {
      const index = pinned.indexOf(base);
      return index === -1 ? pinned.length : index;
    };
    bases.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (source.sort === "number" ? Number.parseInt(a, 10) - Number.parseInt(b, 10) : 0) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const base of bases) {
      entries.push({
        path: `${source.dir}/${base}.md`,
        slug: source.slug(base),
        section: source.section,
      });
    }
  }

  if (missing.length > 0) {
    fail(`missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }
  return { entries, skipped };
}

function build() {
  const { entries, skipped } = collectInventory();
  const sectionOrder = new Map(SECTIONS.map((section) => [section.id, section.order]));

  const bySlug = new Map();
  const pages = [];
  for (const entry of entries) {
    if (!sectionOrder.has(entry.section)) fail(`unknown section "${entry.section}" for ${entry.path}`);
    if (bySlug.has(entry.slug)) fail(`duplicate slug ${entry.slug} (${entry.path} and ${bySlug.get(entry.slug)})`);
    bySlug.set(entry.slug, entry.path);
    const { title, headings, body } = parsePage(entry.path);
    pages.push({ path: entry.path, slug: entry.slug, title, section: entry.section, order: 0, headings, body });
  }
  pages.sort((a, b) => sectionOrder.get(a.section) - sectionOrder.get(b.section));

  const sections = [];
  for (const section of SECTIONS) {
    const members = pages.filter((page) => page.section === section.id);
    if (members.length === 0) continue;
    members.forEach((page, index) => {
      page.order = index;
    });
    sections.push({ id: section.id, title: section.title, pages: members.map((page) => page.slug) });
  }

  return { skipped, index: { count: pages.length, pages, sections } };
}

const { skipped, index } = build();
emit(index);

const counts = index.sections.map((section) => `${section.id} ${section.pages.length}`).join(", ");
const skippedNote = skipped.length > 0 ? ` [skipped: ${skipped.map((path) => `${path} not present`).join(", ")}]` : "";
// Stated every run so the extension is not "helpfully" flipped back: the corpus is
// plain markdown and the fumadocs-mdx parser is chosen by extension, not by config.
console.log(
  `content: ${index.count} pages (${counts}) mirror: ${PAGE_EXT} (mdx parser unsafe for this corpus)${skippedNote}`,
);
