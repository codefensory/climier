import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import storybookTest from "@storybook/addon-vitest/vitest-plugin";

/**
 * Vitest corriendo las stories en un navegador real.
 *
 * El addon `@storybook/addon-vitest` convierte cada story en un test de humo: la monta, y si tira una
 * excepción el test falla. Con 135 stories eso ya cubre piezas de todas las capas. Lo que agrega de
 * verdad son las 15 funciones `play`: una story con `play` deja de ser una foto y pasa a ser un test de
 * interacción.
 *
 * ### Por qué navegador real y no jsdom
 *
 * Porque el DOM de este proyecto **depende del layout**: los menús portaleados calculan su posición
 * midiendo el trigger con `getBoundingClientRect`, y el board cambia de lista a kanban según
 * `matchMedia`. jsdom no tiene layout (todo mide 0) ni `matchMedia`, así que los caminos que más se
 * rompen serían justo los que no se probarían.
 *
 * ### `storybookTest()` es async
 *
 * Devuelve una promesa con los plugins, así que se resuelve con **top-level await** y no con
 * `defineConfig(async () => …)`: esa forma funciona en runtime, pero el `defineConfig` de `vitest/config`
 * no la tipa (`TS2769`). Se descubrió al agregar este archivo a `tsconfig.node.json`, que es lo que hace
 * que un archivo de configuración deje de ser código sin verificar.
 *
 * ### Chromium
 *
 * Headless por defecto. El provider viene de `@vitest/browser-playwright` (Vitest 4+ lo separó del core).
 */
const storybookPlugins = await storybookTest({ configDir: ".storybook" });

export default defineConfig({
  test: {
    projects: [
      {
        plugins: storybookPlugins,
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        plugins: [solid(), tailwindcss()],
        test: {
          name: "unit",
          include: ["src/**/*.test.@(ts|tsx)"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
