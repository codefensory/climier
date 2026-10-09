import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchIndex } from '../src/lib/search.ts';
import { normalizeBasePath } from './site-paths.mjs';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const basePath = normalizeBasePath();
// The base path lives in URLs only: the artifact is served with its root mapped
// onto the site root, so the index ships at `api/search`.
const result = await buildSearchIndex({
  contentDir: path.join(docsRoot, 'content/docs'),
  outputDir: path.join(docsRoot, '.output/public'),
  basePath,
});
console.log(`Generated search index for ${result.documents.length} documents at ${result.outputPath}`);
