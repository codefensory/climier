import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '../..');
export const CANONICAL_FILES = [
  {
    source: 'docs/reference.md',
    output: 'docs/content/docs/reference/cli.mdx',
    title: 'CLI Reference',
    description: 'Every Climier command, flag, JSON envelope, and exit code.',
  },
  {
    source: 'docs/PLUGINS.md',
    output: 'docs/content/docs/reference/plugins.mdx',
    title: 'Plugins V1',
    description: 'Author, install, and verify a Climier Plugin API v1 plugin.',
  },
  {
    source: 'docs/remote-server.md',
    output: 'docs/content/docs/reference/self-hosting.mdx',
    title: 'Operating a Climier remote server',
    description: 'Run an authenticated Climier remote server as the source of truth for a project.',
  },
];

export function outputPath(entry) {
  return entry.output;
}

function frontmatter(entry) {
  const description = entry.description ? `description: ${entry.description}\n` : '';
  return `---\ntitle: ${entry.title}\n${description}---\n\n`;
}

/**
 * Drop a leading level-1 heading from the canonical source.
 *
 * The docs collection renders the page title from frontmatter, so the source's
 * own `# Title` line would show up as a duplicate. Only the first heading is
 * removed, and only when it is the first non-empty line.
 */
function stripLeadingTitle(source) {
  return source.replace(/^\s*#\s+[^\n]*\n+/, '');
}

function outputContent(entry, source) {
  return `${frontmatter(entry)}${stripLeadingTitle(source)}`;
}

async function expectedContent(rootDir, entry) {
  const source = await readFile(path.join(rootDir, entry.source), 'utf8');
  return outputContent(entry, source);
}

function staleError(entry) {
  return new Error(
    `canonical documentation is stale: ${entry.source} does not match ${entry.output}; `
      + 'run node docs/scripts/sync-canonical.mjs',
  );
}

export async function syncCanonical(rootDir = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(rootDir);
  const files = [];

  for (const entry of CANONICAL_FILES) {
    const output = path.join(resolvedRoot, outputPath(entry));
    const content = await expectedContent(resolvedRoot, entry);
    await mkdir(path.dirname(output), { recursive: true });

    const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, output);
    files.push(outputPath(entry));
  }

  return { rootDir: resolvedRoot, files };
}

export async function assertCanonicalFresh(rootDir = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(rootDir);

  for (const entry of CANONICAL_FILES) {
    const expected = await expectedContent(resolvedRoot, entry);
    let actual;
    try {
      actual = await readFile(path.join(resolvedRoot, outputPath(entry)), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw staleError(entry);
      throw error;
    }

    if (actual !== expected) throw staleError(entry);
  }

  return { rootDir: resolvedRoot, files: CANONICAL_FILES.map(outputPath) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncCanonical(process.argv[2] || DEFAULT_ROOT);
  console.log(`Synced ${result.files.length} canonical documents.`);
}
