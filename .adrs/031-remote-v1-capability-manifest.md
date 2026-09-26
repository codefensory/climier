# ADR-031: manifiesto de capacidades del protocolo remote-v1

- Gate: `G-remote-architecture-refactor-adr-031` · Deriva de: `G-remote-architecture-refactor-rfc` · Estado: borrador
- Fecha: 2026-09-26

## Contexto

Los operation IDs canónicos pertenecen al catálogo built-in de Application Operations. El servidor HTTP además mantiene schemas superficiales/allowlists para requests remotos, y el backend cliente necesita saber qué operaciones soporta remote-v1. Si se mezclan esos datos en el catálogo general o se duplican por adapter, las capacidades locales válidas pueden quedar limitadas accidentalmente y las superficies HTTP/cliente pueden divergir.

La decisión deriva de la sección D del [RFC de consolidación post remote-v1](../.decisions/G-remote-architecture-refactor-rfc.md). El RFC deja claro que este manifiesto no autoriza un cambio de protocolo o seguridad.

## Decisión

1. Mantener el catálogo built-in de Application Operations como única fuente de IDs, providers y semántica canónica.
2. Añadir el manifiesto estático, versionado y data-only en `src/application/operations/remote-v1-manifest.mjs`, como proyección exclusiva de capacidades remote-v1. Cada entrada de operación referencia un ID provider-backed ya existente y declara solo los campos superficiales permitidos por HTTP y su elegibilidad para batch. `if_revision`, cuando aplique, es un campo wire HTTP superficial en esa entrada; la regla de selección/población de la revisión esperada pertenece al router CLI, igual que el resto de metadata de adaptación CLI (target/pre-read y localizador del resultado). Las pruebas de paridad relacionan ambos owners por operation ID, sin duplicar esa metadata en el manifiesto.
3. Describir el envelope `core.batch` en una sección `batch` separada de las entradas provider-backed: `core.batch` es una capacidad/envelope de protocolo compuesto, no un operation ID del catálogo ni un provider que se registre. Su metadata fija los campos del envelope y deriva las suboperaciones elegibles de las entradas con `batch: true`; no permite batches anidados. Mantener el conjunto actual (los 21 operation IDs built-in) elegible para batch, sujeto a la matriz de paridad.
4. El servidor deriva de esa proyección su allowlist y validación superficial; el backend remoto deriva de ella sus IDs soportados. La proyección nunca alimenta el bridge/backend local como catálogo general.
5. Mantener validación profunda de payload hostil, auth, scope, catálogo y semántica del provider en el servidor. Un manifiesto no sustituye autorización ni valida por sí solo el contrato completo de una operación.
6. El router CLI posee exclusivamente metadata de adaptación argv/target/pre-read/revision/result locator. No duplica IDs canónicos ni campos HTTP. `cli/dispatch` conserva su allowlist de comandos como superficie CLI separada.
7. Añadir pruebas de consistencia que rechacen IDs ausentes del catálogo, capacidades remotas sin entrada correspondiente, metadata duplicada/incoherente y pérdida accidental de operaciones locales no remotas.
8. Esta decisión no cambia `PROTOCOL_VERSION`, envelopes, auth/origin binding, operaciones soportadas, protocolo wire ni comportamiento runtime en remote-v1.

## Consecuencias

- A favor: cliente y servidor comparten una sola declaración de capacidades remotas sin reemplazar el catálogo canónico.
- A favor: operaciones válidas locales pueden seguir usando el catálogo aunque no sean parte de remote-v1.
- A favor: schemas/allowlists manuales pasan a tener un owner verificable y tests de coherencia.
- En contra / deuda: el manifiesto es otra proyección de datos que debe evolucionar junto al protocolo, aunque no sea un catálogo general.
- En contra / deuda: el router CLI y el manifiesto conservan metadata distinta; las pruebas deben proteger esa división de ownership.

## Plan de implementación

1. **Inventario y contrato de remote-v1** — archivos: `src/application/operations/builtins.mjs`, `src/server/http.mjs`, `src/application/backend-client.mjs`, tests de HTTP/bridge. Comparar catálogo built-in, `OPERATION_IDS`/`ALLOWED_INPUT_FIELDS` y elegibilidad actual de cada suboperación en batch. Registrar por separado el envelope compuesto `core.batch`.
2. **Manifiesto versionado** — archivo: `src/application/operations/remote-v1-manifest.mjs`. Mantener datos estáticos/serializables; no registrar providers ni importar adapters. Las entradas provider-backed contienen ID, campos HTTP y flag de batch; el descriptor `batch` documenta el envelope `core.batch` y deriva los IDs batch-eligible de esas entradas.
3. **Adaptar consumidor servidor** — archivos: `src/server/http.mjs` y tests HTTP. Derivar campos/allowlists manteniendo rechazo de propiedades desconocidas y validación profunda. Mantener el dispatch compuesto de `core.batch` hacia `executeBatch`, sin tratarlo como provider ni admitir nesting.
4. **Adaptar cliente remoto** — archivos: `src/application/backend-client.mjs` y tests de backend. Derivar IDs soportados de entradas provider-backed; aceptar el envelope separado de `core.batch` y no reducir el catálogo local/bridge.
5. **Conformance matrix** — tests de catálogo/bridge, manifiesto, cliente, servidor y batch; afirmar que los IDs de `operations` igualan los 21 IDs provider-backed hoy soportados por el server, que las suboperaciones elegibles para batch igualan ese conjunto actual, que no hay nesting, que campos HTTP son coherentes y que no se pierden operaciones locales no remotas.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — inspeccionados catálogo/provider IDs, bridge, schema HTTP, backend client y allowlist de commands CLI. El manifiesto se fija en `src/application/operations/remote-v1-manifest.mjs`; `operations[]` declara ID/campos HTTP/batch y `batch` describe el envelope compuesto por separado. Metadata target/pre-read/result locator permanece solo en el router CLI. La futura edición/conformance del server debe aceptarse antes de iniciar las extracciones de ADR-032.
- [ ] No hace falta —

## Verificación

- Cada entrada bajo `operations` del manifiesto referencia exactamente un ID del catálogo built-in y no registra ni redefine providers; el campo `batch` es una marca por suboperación y el descriptor top-level `batch` es separado, no un provider-backed ID.
- El descriptor top-level `batch` conserva el envelope `core.batch`, deriva suboperaciones elegibles solo desde entradas marcadas, no permite nesting y las pruebas fijan los 21 IDs built-in actuales como elegibles.
- Los tests de consistencia prueban que el servidor y el backend remoto obtienen sus capacidades del mismo manifiesto y que el backend local/bridge conserva el catálogo completo.
- Para evitar una edición paralela de `src/server/http.mjs` y `test/server-http.test.mjs`, la integración del manifiesto al server y su task de conformance forman un prerequisite aceptado de las tasks de extracción de ADR-032; este orden se declara en ambos ADRs y en las dependencias de tasks futuras.
- Pruebas de contrato HTTP siguen rechazando campos desconocidos/hostiles y conservan auth, scope, `core.batch`, versión, envelopes y errores.
- Los tests de backend cliente conservan fail-closed/no-fallback en capacidades no soportadas y errores de protocolo.
- Ejecutar `test/server-http.test.mjs`, las pruebas de `application/backend-client` y operations registry relevantes, luego `npm test` y `git diff --check`. Oxlint permanece informativo.
