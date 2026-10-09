import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_FILES,
  assertCanonicalFresh,
  generatedPath,
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

test('syncs every canonical document into the generated docs collection', async () => {
  const root = await fixture();

  const result = await syncCanonical(root);

  assert.equal(result.files.length, 3);
  for (const entry of CANONICAL_FILES) {
    const output = await readFile(path.join(root, generatedPath(entry)), 'utf8');
    assert.match(output, /^---\ntitle: /);
    assert.match(output, new RegExp(`Canonical body for ${entry.source.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`));
  }
  await assertCanonicalFresh(root);
});

test('freshness check rejects a stale generated document', async () => {
  const root = await fixture();
  await syncCanonical(root);

  const stalePath = path.join(root, generatedPath(CANONICAL_FILES[0]));
  await writeFile(stalePath, `${await readFile(stalePath, 'utf8')}\nStale generated content.\n`);

  await assert.rejects(
    () => assertCanonicalFresh(root),
    /canonical documentation is stale: .*reference\.md/,
  );
});

test('freshness check rejects a missing generated document', async () => {
  const root = await fixture();
  await syncCanonical(root);

  const missingPath = path.join(root, generatedPath(CANONICAL_FILES[1]));
  await unlink(missingPath);

  await assert.rejects(
    () => assertCanonicalFresh(root),
    /canonical documentation is stale: .*PLUGINS\.md/,
  );
});
