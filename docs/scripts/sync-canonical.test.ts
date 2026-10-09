import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_FILES,
  assertCanonicalFresh,
  outputPath,
  syncCanonical,
} from './sync-canonical.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'climier-canonical-'));
  for (const { source } of CANONICAL_FILES) {
    const sourcePath = path.join(root, source);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, `# ${source}\n\nCanonical body for ${source}.\n`);
  }
  return root;
}

test('syncs every canonical document into the reference docs collection', async () => {
  const root = await fixture();

  const result = await syncCanonical(root);

  assert.deepEqual(result.files, [
    'docs/content/docs/reference/cli.mdx',
    'docs/content/docs/reference/plugins.mdx',
    'docs/content/docs/reference/self-hosting.mdx',
  ]);
  for (const entry of CANONICAL_FILES) {
    const output = await readFile(path.join(root, outputPath(entry)), 'utf8');
    assert.match(output, /^---\ntitle: /);
    assert.match(output, new RegExp(`Canonical body for ${entry.source.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`));
  }
  await assertCanonicalFresh(root);
});

test('drops the redundant leading H1 so the page title is rendered once', async () => {
  const root = await fixture();
  await syncCanonical(root);

  for (const entry of CANONICAL_FILES) {
    const output = await readFile(path.join(root, outputPath(entry)), 'utf8');
    const body = output.slice(output.indexOf('\n---\n') + 5).trimStart();
    assert.doesNotMatch(body, /^#\s/m, `${entry.output} must not repeat the frontmatter title as a heading`);
    assert.match(body, /^Canonical body for /);
  }
});

test('freshness check rejects a stale reference document', async () => {
  const root = await fixture();
  await syncCanonical(root);

  const stalePath = path.join(root, outputPath(CANONICAL_FILES[0]));
  await writeFile(stalePath, `${await readFile(stalePath, 'utf8')}\nStale reference content.\n`);

  await assert.rejects(
    () => assertCanonicalFresh(root),
    /canonical documentation is stale: .*reference\.md/,
  );
});

test('freshness check rejects a missing reference document', async () => {
  const root = await fixture();
  await syncCanonical(root);

  const missingPath = path.join(root, outputPath(CANONICAL_FILES[1]));
  await unlink(missingPath);

  await assert.rejects(
    () => assertCanonicalFresh(root),
    /canonical documentation is stale: .*PLUGINS\.md/,
  );
});
