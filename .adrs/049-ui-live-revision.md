# ADR-049: actualización en vivo por revisión (SSE + ETag)

- Gate: `G-ui-adr-live-revision` · Deriva de: `G-ui-hosted-rfc` · Estado: aprobado
- Fecha: 2026-10-05

## Contexto

La UI anterior hacía polling de un snapshot completo cada 2 s. Con el server
multi-proyecto y nodos reales (~594 nodos, ~4.7 MiB crudo), repetir esa
descarga es caro. El usuario pide que el estado se mantenga actualizado sin
recargar la página. Ver `.decisions/G-ui-hosted-rfc.md`.

## Decisión

1. **Invalidación por revisión, no por payload**: cada proyecto expone
   `GET /v1/projects/:id/ui/events` como `text/event-stream` que emite
   `data: {"revision":N}` solo cuando la revisión cambió, más un heartbeat
   periódico.
2. **Revalidación con ETag**: `GET /ui/snapshot` responde
   `ETag: "<revision>"`; con `If-None-Match` coincidente responde `304` sin
   cuerpo. El cliente no reemplaza el store ante `304`.
3. **Compresión**: `gzip` (y `br` si está disponible) según
   `Accept-Encoding`, con cache del cuerpo comprimido por revisión. El snapshot
   comprimido se calcula una vez por revisión, no por request.
4. **Watcher autoritativo**: watcher por proyecto compartido entre conexiones
   SSE del mismo proyecto. Observa el **directorio** del proyecto (los commits
   renombran el ledger atómicamente), re-resuelve el path del ledger vigente y
   usa un poll periódico del `revision-ledger.json` como verdad autoritativa.
   El stream nunca depende de que `fs.watch` dispare. Los watchers se cierran
   al desconectar el último SSE del proyecto y al cerrar el server.
5. **Cliente**: consume el SSE con `fetch` + `ReadableStream` (`EventSource` no
   permite el header de protocolo ni el bearer) mediante un parser SSE mínimo y
   testeable. Reconecta con backoff exponencial + jitter; mientras no hay
   stream muestra estado **stale/offline** con la última actualización y acción
   de reintento. Un bearer inválido detiene el stream y vuelve al login.
6. **Sin WebSocket**: no hay escrituras desde la UI; el flujo es
   server→cliente de invalidación.

## Consecuencias

- A favor: sin recarga de página; un cambio real cuesta un `304` o un body
  comprimido una vez, no un snapshot completo cada 2 s.
- A favor: el cliente conserva el último snapshot bueno y expone frescura;
  una caída del stream es visible, no silenciosa.
- En contra / deuda: un endpoint de streaming y un watcher por proyecto; hay
  que testear cierre de recursos y no filtrar file handles.
- En contra / deuda: el ETag depende de que la revisión sea monótona y por
  proyecto; el ledger ya la mantiene, no se introduce una segunda fuente.
- En contra / deuda: con varios proyectos abiertos en varias pestañas hay
  watchers por proyecto; se comparten y se cierran con el último consumidor.

## Plan de implementación

1. **ETag + compresión del snapshot** — `src/server/http/ui-api.mjs`,
   `src/server/http/static.mjs` (helpers de compresión),
   `test/server/http/ui-api.test.mjs`. `304` y cuerpos comprimidos cacheados
   por revisión.
2. **Watcher de revisión** — `src/server/ui/revision-watcher.mjs`,
   `test/server/ui-revision-watcher.test.mjs` (cambio de revisión, rename,
   share, close, heartbeat).
3. **Ruta SSE** — `src/server/http/ui-events.mjs`, montaje y
   `test/server/http/ui-events.test.mjs` (headers, solo cambios, heartbeat,
   cierre al desconectar).
4. **Transporte cliente** — store reactivo con SSE, backoff, estado
   stale/offline y revalidación ETag; `test`/stories del cliente.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — ETag/compresión, watcher y ruta SSE comparten
  `src/server/http.mjs` como wiring: un único owner. El transporte cliente es
  una task separada en `ui/src`.

## Verificación

- `node --test test/server/ui-revision-watcher.test.mjs`.
- `node --test test/server/http/ui-api.test.mjs` (304, gzip/br, cache por
  revisión).
- `node --test test/server/http/ui-events.test.mjs` (conexión autenticada, solo
  cambios de revisión, heartbeat, cierre).
- En el cliente: prueba de backoff/reconexión y de que un `304` no reemplaza el
  snapshot.
- E2E con `ego-browser`: una mutación CLI se refleja en el navegador sin
  recargar.
