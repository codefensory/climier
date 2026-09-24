/**
 * content-manifest.mjs — dependency-free read API over web/content.generated.json.
 *
 * The JSON is a build artifact; import this module rather than the JSON directly so
 * renderers share one lookup surface (`pages`, `sections`, `bySlug`, `byPath`,
 * `linkForRef`). Nothing here touches the filesystem at import time beyond loading
 * that one generated file, and every lookup fails soft: unknown slug/path/reference
 * yields `undefined`/`null` instead of throwing, so the site degrades when a page is
 * added or removed between a build and a run.
 *
 * Regenerate the artifact with: node web/scripts/gen-content.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let generated;
try {
  generated = require("./content.generated.json");
} catch (cause) {
  throw new Error(
    "web/content.generated.json is missing or unreadable; run `node web/scripts/gen-content.mjs` to generate it.",
    { cause },
  );
}

/** Every page, in site order (sections in registry order, pages in nav order). */
export const pages = generated.pages;

/** Every non-empty section: `{ id, title, pages: [slug, ...] }`, in site order. */
export const sections = generated.sections;

const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));
const pagesByPath = new Map(pages.map((page) => [page.path, page]));

/** @returns {object|undefined} page for a slug such as `/adr/021-plugin-foundation-public-api`. */
export function bySlug(slug) {
  return pagesBySlug.get(slug);
}

/** @returns {object|null} page for a repo-relative source path such as `.adrs/021-plugin-foundation-public-api.md`. */
export function byPath(path) {
  return pagesByPath.get(path) ?? null;
}

/**
 * Resolves the reference forms used across the corpus to a site slug.
 *
 * Accepts `docs/x.md`, `docs/plans/x.md`, `.adrs/021-x.md`, `.decisions/G-x.md`,
 * `README.md`, `CHANGELOG.md`, `CLIMIER-CHEATSHEET.md`, `ui/DESIGN.md`, each with or
 * without a leading `./` and with an optional `#anchor` (the anchor is used only to
 * isolate the path and is not part of the returned slug).
 *
 * @returns {string|null} slug, or `null` when the reference is not a known page.
 */
export function linkForRef(ref) {
  if (typeof ref !== "string") return null;
  const path = ref.trim().split("#", 1)[0].replace(/^\.\//, "");
  if (path === "") return null;
  return pagesByPath.get(path)?.slug ?? null;
}
