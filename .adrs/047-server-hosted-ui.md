# ADR-047: hosting de la SPA por el server y reemplazo de la UI experimental

- Gate: `G-ui-adr-hosting` · Deriva de: `G-ui-hosted-rfc` · Estado: borrador
- Fecha: 2026-10-05

## Contexto

La UI experimental en `ui/` es un subproyecto Express + Solid que el CLI raíz
evita publicar. El nuevo cliente (`climier-ui`, `/home/yeferson/dev/climier-ui`)
es SolidJS + Vite y produce un bundle estático en `ui/dist`. El objetivo es que
el climier server entregue el entry de la UI en el mismo origen que `/v1`, sin
un segundo proceso ni framework. Ver `.decisions/G-ui-hosted-rfc.md`.

## Decisión

1. **Una sola UI**: `ui/` contiene `climier-ui` como subproyecto autocontenido
   (su `package.json`, `bun.lock`, `node_modules/`, `.storybook/`, `dist/`).
   Se eliminan `ui/server/server.mjs` y la dependencia `express`.
2. **Handler estático stdlib** en `src/server/http/static.mjs`:
   `createStaticHandler({ root, indexFile })` que resuelve archivos con
   path confinement (nada fuera de `root`, sin symlink escape), MIME por
   extensión, `HEAD`, `Cache-Control: public, max-age=31536000, immutable` para
   `/assets/*` hasheados y `no-cache` para `index.html`, y fallback SPA
   (`index.html`) para `GET`/`HEAD` que no empiecen con `/v1/`.
3. **Montaje antes del dispatch API** en `src/server/http.mjs`. `/v1/*` conserva
   exactamente su contrato y nunca devuelve `index.html`: una ruta `/v1`
   desconocida sigue siendo `404 ROUTE_NOT_FOUND` JSON.
4. **Config `uiRoot`** opcional en `src/server/runtime-config.mjs` (allowlist),
   default `<pkgRoot>/ui/dist`. Si falta el build, `/` responde un mensaje
   claro y `/v1/*` no se ve afectado. No se agregan otras claves.
5. **Empaquetado**: `package.json#files` incluye `ui/dist` para que un server
   instalado desde el paquete pueda servir la UI; el server sigue funcionando
   sin ella.
6. **`climier ui` deja de usar Express**: se reimplementa sobre el handler
   estático y la proyección de UI compartidos, con un adaptador local loopback
   que resuelve el proyecto del cwd (sin catálogo remoto ni bearer). Read-only,
   local-only.
7. **Import reproducible** desde `climier-ui` en el commit fijo `c2aa000`;
   se copian fuentes/config/storybook/scripts/docs/`bun.lock` y se excluyen
   `.git`, `node_modules`, `dist`, `storybook-static`, `.ui-bridge`, `dom`,
   `.logs`. Toolchain Bun fijado por `bun.lock`.

## Consecuencias

- A favor: un solo proceso y un solo origen para SPA + API; sin CORS; el
  header de protocolo y el bearer ya existen; el subproyecto UI mantiene sus
  deps fuera del paquete CLI.
- A favor: `ui/dist` es estático y cacheable; el server no necesita deps
  runtime nuevas.
- En contra / deuda: el static serving, la compresión y el SSE se implementan a
  mano sobre stdlib; hay que cubrirlos con tests de traversal, MIME, cache y
  fallback.
- En contra / deuda: quien despliegue desde el paquete debe construir `ui/dist`
  o usar el paquete con ese directorio incluido; se documenta.
- En contra / deuda: `climier ui` cambia de implementación; su test y su ayuda
  se actualizan en la misma entrega.

## Plan de implementación

1. **Handler estático** — `src/server/http/static.mjs`,
   `test/server/http/static.test.mjs`. Sin tocar rutas API.
2. **Wiring y config del server** — `src/server/http.mjs`,
   `src/server/runtime-config.mjs`, `src/server/runtime.mjs`,
   `test/server-runtime.test.mjs`. Montar antes del dispatch, `uiRoot`, aviso
   sin build.
3. **Import de la UI** — `ui/**`, `.gitignore`, `package.json` (`files`).
   Build y typecheck con Bun.
4. **`climier ui` local** — `src/cli/commands/ui.mjs`, `test/command-ui.test.mjs`.
   Adaptador local loopback sobre static + proyección; sin Express.
5. **Docs y packaging** — `README.md`, `docs/remote-server.md`,
   `docs/climier-ui.md`, `scripts/check-retired-surfaces.mjs` si aplica.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — paths separables: static module, wiring/config,
  import de `ui/**`, comando local, docs/packaging. `src/server/http.mjs` queda
  como owner único del wiring; import y comando local son tasks distintas.

## Verificación

- `node --test test/server/http/static.test.mjs` (traversal, MIME, cache, SPA
  fallback, `/v1` no absorbido).
- `node --test test/server-runtime.test.mjs` (server sirve un `uiRoot` temporal;
  sin build responde aviso y `/v1` sigue OK).
- `node --test test/command-ui.test.mjs`.
- `cd ui && bun install --frozen-lockfile && bun run typecheck && bun run build`
  produce `ui/dist/index.html` y assets hasheados.
- `npm test` en la raíz sigue verde.
