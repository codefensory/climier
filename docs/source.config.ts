import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    files: ['**/*.mdx', '**/*.md'],
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
