/**
 * remark-linkify.mjs — compile-time remark plugin for the docs site.
 *
 * Turns inline-code repo-path references (`` `.adrs/021-x.md` ``, `docs/PLUGINS.md`,
 * each with an optional leading `./` and trailing `#anchor`) into site links whose
 * visible text is the original code span. Runs inside fumadocs-mdx's MDX pipeline on
 * the parsed mdast: fenced blocks are `code` nodes whose content is a plain string
 * and is never walked, so fences are safe by construction.
 *
 * Registered in `source.config.ts` via the global `mdxOptions`
 * (`remarkPlugins: [[remarkLinkify, manifest]]`); fumadocs-mdx wraps global options in
 * its own preset, so GFM/heading behavior is untouched.
 */

/**
 * Normalize a manifest into a `path -> page` lookup. Accepts the generated JSON
 * (`pages[]`) or the runtime manifest module API (`byPath`).
 */
function toByPath(manifest) {
  if (typeof manifest?.byPath === "function") return manifest.byPath;
  const byPath = new Map((manifest?.pages ?? []).map((page) => [page.path, page]));
  return (path) => byPath.get(path) ?? null;
}

/** Resolve one inline-code value to a site URL, or null when it is not a known page reference. */
function resolveUrl(value, byPath) {
  if (typeof value !== "string") return null;
  const hash = value.indexOf("#");
  const path = (hash === -1 ? value : value.slice(0, hash)).replace(/^\.\//, "");
  if (path === "") return null;
  const page = byPath(path);
  if (!page) return null;
  return page.slug + (hash === -1 ? "" : value.slice(hash));
}

/**
 * Depth-first walk over `children` arrays. `inLink` is true below a `link` node so a
 * code span that is already link text is never wrapped in a second link. `code`
 * block values are strings without children, so fenced content is never visited.
 */
function walk(node, visit, inLink = false) {
  const { children } = node;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!inLink) visit(child);
    // `visit` may have just turned `child` into a link — re-check after it runs.
    walk(child, visit, inLink || child.type === "link");
  }
}

/**
 * Unified/remark plugin factory: `remarkLinkify(manifest)` returns a transformer that
 * rewrites every resolvable `inlineCode` node in place into a `link` node
 * (`url` = slug + anchor) whose child is the original code span. Unresolvable values
 * are left untouched. Idempotent: `link` nodes are never re-entered (see `walk`).
 */
export function remarkLinkify(manifest) {
  const byPath = toByPath(manifest);
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== "inlineCode") return;
      const url = resolveUrl(node.value, byPath);
      if (url === null) return;
      const value = node.value;
      node.type = "link";
      node.url = url;
      node.title = null;
      node.children = [{ type: "inlineCode", value }];
    });
  };
}
