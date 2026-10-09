import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create, insertMultipleAsync, save } from 'zbsearch';

export const SEARCH_OUTPUT_PATH = 'api/search';

export interface SearchDocument {
  title: string;
  description: string;
  breadcrumbs: string[];
  content: string;
  keywords: string;
  url: string;
  locale: string;
}

interface BuildSearchIndexOptions {
  contentDir?: string;
  outputDir?: string;
  basePath?: string;
}

function normalizeBasePath(basePath = process.env.DOCS_BASE_PATH ?? '/') {
  const value = basePath.trim();
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function readFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const values = new Map<string, string>();
  if (!match) return { values, body: markdown };

  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    values.set(key, value);
  }

  return { values, body: markdown.slice(match[0].length) };
}

function titleFromBody(body: string, fallback: string) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function documentUrl(filePath: string, contentDir: string, basePath: string) {
  const relative = path.relative(contentDir, filePath).replaceAll(path.sep, '/');
  const withoutExtension = relative.replace(/\.(?:md|mdx)$/i, '');
  const segments = withoutExtension.split('/');
  if (segments.at(-1) === 'index') segments.pop();
  const suffix = segments.length > 0 ? `/${segments.join('/')}` : '';
  return `${basePath}/docs${suffix}` || '/docs';
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(filePath)));
    else if (/\.(?:md|mdx)$/i.test(entry.name)) files.push(filePath);
  }
  return files.sort();
}

export async function collectSearchDocuments(
  contentDir: string,
  basePath = '/',
): Promise<SearchDocument[]> {
  const normalizedBasePath = normalizeBasePath(basePath);
  const files = await markdownFiles(contentDir);
  return Promise.all(
    files.map(async (filePath) => {
      const markdown = await readFile(filePath, 'utf8');
      const { values, body } = readFrontmatter(markdown);
      const fallback = path.basename(filePath).replace(/\.(?:md|mdx)$/i, '');
      const title = values.get('title') ?? titleFromBody(body, fallback);
      const description = values.get('description') ?? '';
      const relative = path.relative(contentDir, filePath).replaceAll(path.sep, '/');
      const breadcrumbs = ['Documentation', ...relative.split('/').slice(0, -1)];

      return {
        title,
        description,
        breadcrumbs,
        content: body,
        keywords: relative,
        url: documentUrl(filePath, contentDir, normalizedBasePath),
        locale: 'en',
      };
    }),
  );
}

export async function buildSearchIndex({
  contentDir = path.resolve('content/docs'),
  outputDir = path.resolve('.output/public'),
  basePath = '/',
}: BuildSearchIndexOptions = {}) {
  const documents = await collectSearchDocuments(contentDir, basePath);
  const database = create({
    schema: {
      url: 'string',
      title: 'string',
      breadcrumbs: 'string[]',
      description: 'string',
      content: 'string',
      keywords: 'string',
      locale: 'enum',
    },
    language: 'multilingual',
  });
  await insertMultipleAsync(database, documents);
  const exported = { type: 'simple', ...save(database) };
  const outputPath = path.join(outputDir, SEARCH_OUTPUT_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(exported)}\n`, 'utf8');
  return { documents, outputPath };
}