/**
 * tests for web/src/lib/links.mjs — linkifyMarkdown over a stub content manifest
 * mirroring the real one's `byPath(path) -> { slug } | null` contract.
 * Run with: node --test web/test/links.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { linkifyMarkdown } from '../src/lib/links.mjs';

const SLUGS = {
  'README.md': '/',
  'CHANGELOG.md': '/changelog',
  'docs/reference.md': '/reference',
  'docs/PLUGINS.md': '/plugins',
  '.adrs/008-core-policy-seam.md': '/adr/008-core-policy-seam',
  '.decisions/G-ui-live-store-rfc.md': '/rfc/G-ui-live-store-rfc',
  'ui/DESIGN.md': '/ui-design',
};

const manifest = {
  byPath: (path) => (Object.hasOwn(SLUGS, path) ? { slug: SLUGS[path] } : null),
};

test('public ADR ref with anchor becomes a code-text link', () => {
  const out = linkifyMarkdown('See `.adrs/008-core-policy-seam.md#takeover` for details', manifest);
  assert.equal(
    out,
    'See [`.adrs/008-core-policy-seam.md#takeover`](/adr/008-core-policy-seam#takeover) for details',
  );
});

test('refs inside a fenced block are untouched; the same ref outside is linked', () => {
  const body = [
    '```bash',
    'cat `docs/PLUGINS.md` | grep plugin',
    '```',
    'Read `docs/PLUGINS.md` first.',
    '',
  ].join('\n');
  const out = linkifyMarkdown(body, manifest);
  assert.ok(out.includes('cat `docs/PLUGINS.md` | grep plugin'), 'fenced line byte-identical');
  assert.ok(
    out.includes('Read [`docs/PLUGINS.md`](/plugins) first.'),
    'same ref outside the fence is linked',
  );
});

test('unknown path stays byte-identical', () => {
  const body = 'See `docs/nope.md` for details.';
  assert.equal(linkifyMarkdown(body, manifest), body);
});

test('three refs on one line all convert', () => {
  const body = '- `docs/PLUGINS.md`, `.decisions/G-ui-live-store-rfc.md`, `ui/DESIGN.md`';
  const out = linkifyMarkdown(body, manifest);
  assert.equal(
    out,
    '- [`docs/PLUGINS.md`](/plugins), [`.decisions/G-ui-live-store-rfc.md`](/rfc/G-ui-live-store-rfc), [`ui/DESIGN.md`](/ui-design)',
  );
});

test('pre-existing link with code-span text is untouched', () => {
  const body = 'See [`docs/reference.md`](/reference) now.';
  assert.equal(linkifyMarkdown(body, manifest), body);
});

test('table row: both refs convert, pipes intact', () => {
  const body = '| `docs/reference.md` | `ui/DESIGN.md` |';
  const out = linkifyMarkdown(body, manifest);
  assert.equal(out, '| [`docs/reference.md`](/reference) | [`ui/DESIGN.md`](/ui-design) |');
});

test('idempotent over a fixture mixing all rules', () => {
  const body = [
    '# Setup',
    '',
    'Start with `README.md`, then `.adrs/008-core-policy-seam.md#takeover`.',
    '',
    '```bash',
    'cat `docs/PLUGINS.md`',
    '```',
    '',
    '| Path | Ref |',
    '| --- | --- |',
    '| guide | `ui/DESIGN.md` |',
    '',
    '    indented code keeps `docs/reference.md` plain',
    '',
    'Existing: [`docs/reference.md`](/reference). Unknown: `docs/nope.md`.',
    'Image ![alt](img.png) and autolink <https://example.com/x> stay.',
    '',
  ].join('\n');
  const once = linkifyMarkdown(body, manifest);
  assert.equal(linkifyMarkdown(once, manifest), once);
  assert.ok(once.includes('[`README.md`](/)'));
  assert.ok(once.includes('cat `docs/PLUGINS.md`'));
  assert.ok(once.includes('keeps `docs/reference.md` plain'));
});

test('empty string maps to empty string', () => {
  assert.equal(linkifyMarkdown('', manifest), '');
});

test('non-string body throws TypeError', () => {
  assert.throws(() => linkifyMarkdown(42, manifest), TypeError);
  assert.throws(() => linkifyMarkdown(null, manifest), TypeError);
  assert.throws(() => linkifyMarkdown(undefined, manifest), TypeError);
});

test('README ref links to the root slug', () => {
  assert.equal(linkifyMarkdown('Intro `README.md` here', manifest), 'Intro [`README.md`](/) here');
});

test('leading ./ is stripped for resolution but kept in link text', () => {
  const out = linkifyMarkdown('See `./docs/PLUGINS.md` next.', manifest);
  assert.equal(out, 'See [`./docs/PLUGINS.md`](/plugins) next.');
});

test('anchor over an unknown base path stays unchanged', () => {
  const body = 'See `.adrs/999-nope.md#anchor` please.';
  assert.equal(linkifyMarkdown(body, manifest), body);
});

test('tilde fence with info string protects refs; length-matched fences too', () => {
  const body = [
    '~~~text',
    '`docs/PLUGINS.md` inside tilde fence',
    '~~~',
    'Out: `docs/PLUGINS.md`.',
    '',
    '````',
    'inner ``` triple fence is content',
    '`ui/DESIGN.md` still fenced',
    '````',
    'After: `ui/DESIGN.md`.',
  ].join('\n');
  const out = linkifyMarkdown(body, manifest);
  assert.ok(out.includes('`docs/PLUGINS.md` inside tilde fence'));
  assert.ok(out.includes('Out: [`docs/PLUGINS.md`](/plugins).'));
  assert.ok(out.includes('`ui/DESIGN.md` still fenced'), '3-backtick line does not close a 4-backtick fence');
  assert.ok(out.includes('After: [`ui/DESIGN.md`](/ui-design).'));
});

test('image targets are not linkified and images stay intact', () => {
  const body = '![`docs/PLUGINS.md`](docs/PLUGINS.md)';
  assert.equal(linkifyMarkdown(body, manifest), body);
});

test('same ref repeated on one line converts every occurrence', () => {
  const out = linkifyMarkdown('`ui/DESIGN.md` and again `ui/DESIGN.md`', manifest);
  assert.equal(
    out,
    '[`ui/DESIGN.md`](/ui-design) and again [`ui/DESIGN.md`](/ui-design)',
  );
});

test('reference definition lines are skipped', () => {
  const body = '[ref]: ./docs/PLUGINS.md "title with `docs/reference.md`"';
  assert.equal(linkifyMarkdown(body, manifest), body);
});

test('lowercase .md is matched exactly; other spellings stay', () => {
  const body = 'No: `docs/PLUGINS.MD` or `docs/PLUGINS.markdown`.';
  assert.equal(linkifyMarkdown(body, manifest), body);
});
