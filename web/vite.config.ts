import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';

export default defineConfig({
  server: {
    host: true,
    port: 4400,
  },
  preview: {
    host: true,
    port: 4400,
  },
  plugins: [
    fumadocsMdx(),
    tanstackStart(),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    // `resolve.tsconfigPaths` needs Vite 8; Vite 7 gets an explicit alias.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      collections: fileURLToPath(new URL('./.source', import.meta.url)),
    },
  },
});
