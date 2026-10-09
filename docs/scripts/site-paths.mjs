import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Base path of the deployed site: `''` when served from a domain root, `'/climier'`
 * for a GitHub project page. It belongs in URLs only, never in artifact paths.
 */
export function normalizeBasePath(value = process.env.DOCS_BASE_PATH ?? '/') {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function publicBasePath(basePath) {
  return `${basePath}/`;
}

export function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(filePath);
    if (!/\.(?:md|mdx)$/i.test(entry.name)) return [];
    return [filePath];
  });
}

/**
 * Public URL paths handed to the prerenderer. They include the base path because
 * Nitro requests `baseURL + route`: a route that already carries the prefix is
 * left untouched, while `withoutBase` strips it back out of the written file.
 * The root keeps its trailing slash, otherwise `withBase` drops it and the
 * router answers `/climier` with a redirect instead of rendering the home page.
 */
export function prerenderRoutes(basePath = '', contentRoot = path.resolve('content/docs')) {
  const paths = new Set([`${basePath}/`]);
  for (const filePath of markdownFiles(contentRoot)) {
    const relative = path.relative(contentRoot, filePath).replaceAll(path.sep, '/');
    const slug = relative
      .replace(/\.(?:md|mdx)$/i, '')
      .replace(/(^|\/)index$/, '');
    paths.add(`${basePath}/docs${slug ? `/${slug}` : ''}`);
  }
  return [...paths];
}

/**
 * The `github-pages` preset injects a bare `/` route on top of the declared
 * routes. With a base path it resolves to `<base>` without the trailing slash,
 * which only yields a redirect and an empty stray file next to `index.html`.
 */
export function dropBareBaseRoute(routes, basePath) {
  if (basePath) routes.delete('/');
  return routes;
}

/** Artifact-relative file the prerenderer writes for a public URL path. */
export function artifactPathForRoute(route, basePath = '') {
  const relative = basePath && route.startsWith(basePath) ? route.slice(basePath.length) : route;
  const trimmed = relative.replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/index.html` : 'index.html';
}
