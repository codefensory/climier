import type { StorybookConfig } from "storybook-solidjs-vite";

/**
 * Configuración de Storybook para climier-ui (SolidJS 1.x + Vite + Tailwind v4).
 *
 * Notas de por qué esto es tan corto:
 * - El preset `storybook-solidjs-vite` auto-fusiona el `vite.config.ts` del proyecto, así que
 *   los plugins `solid()` y `tailwindcss()` se heredan. No hace falta `viteFinal`.
 * - Detecta la versión de Solid leyendo el `solid-js` del proyecto (1.9.15) y elige solo el
 *   renderer legacy. No hay que forzar nada.
 * - El docgen (`componentsManifest`) viene habilitado por defecto vía un plugin de Vite.
 */
const config: StorybookConfig = {
  framework: { name: "storybook-solidjs-vite" },
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
};

export default config;
