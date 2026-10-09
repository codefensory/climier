import path from 'node:path';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { nitro } from 'nitro/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import {
  dropBareBaseRoute,
  normalizeBasePath,
  prerenderRoutes,
  publicBasePath,
} from './scripts/site-paths.mjs';

const basePath = normalizeBasePath();
const publicBase = publicBasePath(basePath);

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
      // `baseURL` is what makes a project Pages site deployable: the prerenderer
      // requests `baseURL + route` and writes `withoutBase(fileName)`, so the
      // artifact root holds `index.html` and `docs/` directly while every URL
      // stays under the project path. Left at `/`, the whole site nests inside a
      // second `<project>/` directory and the deployed root has no `index.html`.
      baseURL: publicBase,
      hooks: {
        'prerender:routes': (routes) => {
          dropBareBaseRoute(routes, basePath);
        },
      },
      prerender: {
        routes: prerenderRoutes(basePath, path.resolve('content/docs')),
        crawlLinks: true,
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
