import { readdirSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { nitro } from 'nitro/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

function normalizeBasePath(value = process.env.DOCS_BASE_PATH ?? '/') {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(filePath);
    if (!/\.(?:md|mdx)$/i.test(entry.name)) return [];
    return [filePath];
  });
}

function prerenderPaths(basePath = '') {
  const contentRoot = path.resolve('content/docs');
  const paths = new Set([`${basePath}/`]);
  for (const filePath of markdownFiles(contentRoot)) {
    const relative = path.relative(contentRoot, filePath).replaceAll(path.sep, '/');
    const slug = relative
      .replace(/\.(?:md|mdx)$/i, '')
      .replace(/(^|\/)index$/, '');
    paths.add(`${basePath}/docs${slug ? `/${slug}` : ''}`);
  }
  return [...paths].map((path) => ({ path }));
}

const basePath = normalizeBasePath();
const publicBase = `${basePath}/`;

export default defineConfig({
  base: publicBase,
  server: {
    port: 3000,
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      router: {
        basepath: basePath || undefined,
      },
    }),
    react(),
    nitro({
      preset: 'github-pages',
      prerender: {
        routes: prerenderPaths(basePath).map(({ path }) => path),
        crawlLinks: true,
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
