import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPagesArtifact } from './check-pages-artifact.mjs';
import { publicBasePath } from './site-paths.mjs';

const HOME_PAGE = (base) =>
  `<!DOCTYPE html><html><head><link rel="stylesheet" href="${base}assets/app.css"></head><body>home</body></html>`;

async function writeArtifact(root, { basePath = '', contentRoot }) {
  const base = publicBasePath(basePath);
  await mkdir(path.join(root, 'api'), { recursive: true });
  await writeFile(path.join(root, 'api', 'search'), 'search-index');
  await writeFile(path.join(root, '.nojekyll'), '');
  await writeFile(path.join(root, 'index.html'), HOME_PAGE(base));
  await mkdir(path.join(root, 'docs/concepts/gates'), { recursive: true });
  await writeFile(path.join(root, 'docs/concepts/gates/index.html'), '<!DOCTYPE html><html>page</html>');
  await mkdir(path.join(contentRoot, 'concepts/gates'), { recursive: true });
  await writeFile(path.join(contentRoot, 'concepts/gates/index.md'), '# Gates\n');
}

export const POSITIVE_FIXTURES = [
  { name: 'custom domain at the root', basePath: '' },
  { name: 'project page under a base path', basePath: '/climier' },
];

export const NEGATIVE_FIXTURES = [
  {
    name: 'artifact without a root index.html',
    basePath: '/climier',
    code: 'MISSING_HOME',
    apply: async (root) => rm(path.join(root, 'index.html')),
  },
  {
    name: 'empty root index.html',
    basePath: '',
    code: 'EMPTY_HOME',
    apply: async (root) => writeFile(path.join(root, 'index.html'), ''),
  },
  {
    name: 'assets referenced outside the base path',
    basePath: '/climier',
    code: 'BASE_MISMATCH',
    apply: async (root) => writeFile(path.join(root, 'index.html'), HOME_PAGE('/')),
  },
  {
    name: 'site nested under a second base directory',
    basePath: '/climier',
    code: 'NESTED_BASE_PATH',
    apply: async (root) => mkdir(path.join(root, 'climier'), { recursive: true }),
  },
  {
    name: 'route that was never prerendered',
    basePath: '/climier',
    code: 'MISSING_ROUTE',
    apply: async (root) => rm(path.join(root, 'docs/concepts/gates'), { recursive: true, force: true }),
  },
  {
    name: 'route prerendered to an empty file',
    basePath: '/climier',
    code: 'EMPTY_ROUTE',
    apply: async (root) => writeFile(path.join(root, 'docs/concepts/gates/index.html'), ''),
  },
  {
    name: 'missing static search index',
    basePath: '/climier',
    code: 'MISSING_SEARCH_INDEX',
    apply: async (root) => rm(path.join(root, 'api/search')),
  },
  {
    name: 'missing .nojekyll',
    basePath: '/climier',
    code: 'MISSING_NOJEKYLL',
    apply: async (root) => rm(path.join(root, '.nojekyll')),
  },
];

export async function runFixtures() {
  for (const fixture of POSITIVE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'climier-pages-artifact-positive-'));
    const contentRoot = path.join(root, 'content');
    try {
      await writeArtifact(root, { basePath: fixture.basePath, contentRoot });
      const result = await checkPagesArtifact(root, { basePath: fixture.basePath, contentRoot });
      assert.deepEqual(result.violations, [], `positive fixture failed: ${fixture.name}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  for (const fixture of NEGATIVE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'climier-pages-artifact-negative-'));
    const contentRoot = path.join(root, 'content');
    try {
      await writeArtifact(root, { basePath: fixture.basePath, contentRoot });
      await fixture.apply(root);
      const result = await checkPagesArtifact(root, { basePath: fixture.basePath, contentRoot });
      assert.ok(
        result.violations.some((item) => item.code === fixture.code),
        `negative fixture unexpectedly passed: ${fixture.name} (${result.violations.map((v) => v.code).join(', ') || 'no violations'})`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return { positive: POSITIVE_FIXTURES.length, negative: NEGATIVE_FIXTURES.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = await runFixtures();
  console.log(`Pages-artifact fixtures passed: ${counts.positive} positive, ${counts.negative} negative.`);
}
