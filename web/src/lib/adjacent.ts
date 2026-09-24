import { createServerFn } from '@tanstack/react-start';

/** Prev/next footer entry, plain data safe to serialize to the client. */
export interface AdjacentLink {
  url: string;
  title: string;
}

export interface AdjacentPages {
  previous: AdjacentLink | null;
  next: AdjacentLink | null;
}

/** Shape of one entry of the manifest `pages` array (flattened in site order). */
interface ManifestPage {
  slug: string;
  title: string;
}

/**
 * Site-order neighbours of a slug, per the `pages` array of
 * web/content.generated.json (the same array web/content-manifest.mjs re-exports).
 *
 * The manifest data MUST stay a dynamic import inside the handler: the file is
 * ~640 kB while only two links are needed per request, so it is bundled into the
 * server chunk at build time and plain {previous,next} data is passed to the
 * client instead. Bundling (rather than a runtime require) also avoids
 * createRequire(import.meta.url) resolving against dist/server/assets/ after the
 * handler is extracted from this module.
 */
export const getAdjacentPages = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<AdjacentPages> => {
    const manifest = await import('../../content.generated.json');
    const pages = manifest.default.pages as ManifestPage[];
    const index = pages.findIndex((page) => page.slug === slug);
    const toLink = (page?: ManifestPage): AdjacentLink | null =>
      page ? { url: page.slug, title: page.title } : null;
    return {
      previous: toLink(pages[index - 1]),
      next: toLink(pages[index + 1]),
    };
  });
