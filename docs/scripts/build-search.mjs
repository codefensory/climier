import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchIndex } from '../src/lib/search.ts';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const basePath = (process.env.DOCS_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
const result = await buildSearchIndex({
  contentDir: path.join(docsRoot, 'content/docs'),
  outputDir: path.join(docsRoot, '.output/public', basePath),
  basePath,
});
console.log(`Generated search index for ${result.documents.length} documents at ${result.outputPath}`);
