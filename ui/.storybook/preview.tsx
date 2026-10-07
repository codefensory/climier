import type { Preview } from "storybook-solidjs-vite";
import { withTheme } from "./decorators";

// CRÍTICO: sin este import, Tailwind no genera las clases usadas por las stories.
// La app lo importa en `src/index.tsx`, pero las stories no pasan por ahí.
import "../src/styles/style.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Global theme for the story canvas",
      defaultValue: "light",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  decorators: [withTheme],
  parameters: {
    // Los menús de sort/group/filter usan <Portal> + position: fixed y calculan su
    // posición leyendo window.innerWidth / window.innerHeight: necesitan el viewport completo.
    layout: "fullscreen",

    // Fase 7 lo pondrá en "error". Mientras tanto no bloquea.
    a11y: { test: "error" },

    backgrounds: { disable: true },

    // Los breakpoints reales de la app (src/styles/style.css) son 1023px y 639px,
    //
    // Los tres van con type "other" a propósito, por dos motivos:
    //  1. No son dispositivos: son los cortes de la app. La categoría es una etiqueta del desplegable.
    //  2. Uno medido: en el corredor de tests (Fase 7), si alguna opción tiene type "mobile" esa pasa a
    //     ser el viewport por defecto e IGNORA este initialGlobals. Con narrow como "mobile" los 135
    //     tests corrían a 639 aunque acá diga "wide"; con los tres en "other", corren a 1440 y coinciden
    //     con lo que se ve en la UI. Ver docs/plan-storybook.md, Fase 7.
    //
    // NO los de Tailwind (sm=640, md=768, lg=1024). Los replicamos exactos.
    viewport: {
      options: {
        wide: {
          name: "wide",
          type: "other",
          styles: { width: "1440px", height: "900px" },
        },
        compact: {
          name: "compact (≤1023)",
          type: "other",
          styles: { width: "1023px", height: "900px" },
        },
        narrow: {
          name: "narrow (≤639)",
          type: "other",
          styles: { width: "639px", height: "900px" },
        },
      },
    },
  },

  initialGlobals: {
    theme: "light",
    viewport: { value: "wide" },
  },
};

export default preview;
