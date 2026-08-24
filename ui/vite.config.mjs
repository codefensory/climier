import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = "http://127.0.0.1:7373";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Forward all /api requests to the local climier UI server.
    // The dev:api script (ui/package.json) boots that server on 127.0.0.1:7373.
    // We strip the /api prefix so the upstream sees clean routes.
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
        ws: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
