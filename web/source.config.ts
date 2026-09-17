import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { remarkLinkify } from './src/lib/remark-linkify.mjs';
import manifest from './content.generated.json';

export const docs = defineDocs({
  dir: './content',
});

// The default export is merged into fumadocs-mdx's global config, which wraps it in
// `applyMdxPreset` itself — GFM/headings/TOC stay intact. Our remark plugin runs after
// `remarkInclude` and turns inline-code path references into site links at compile time.
export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkLinkify, manifest]],
  },
});
