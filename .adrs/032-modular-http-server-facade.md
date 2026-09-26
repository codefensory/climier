# ADR-032: fachada estable y módulos internos del servidor HTTP

- Gate: `G-remote-architecture-refactor-adr-032` · Deriva de: `G-remote-architecture-refactor-rfc` · Estado: borrador
- Fecha: 2026-09-26

## Contexto

`src/server/http.mjs` ensambla el servidor `node:http` y mantiene a la vez helpers de transporte, validación de operaciones/transferencias, parsing de lecturas, proyecciones y dispatch. El módulo ya tiene seams identificables, pero el request order, auth/scope, project opener, el source de operaciones y los puertos de kernel forman un contrato sensible. El runtime que escucha vive aparte.

La decisión deriva de la sección D del [RFC de consolidación post remote-v1](../.decisions/G-remote-architecture-refactor-rfc.md). Debe ejecutarse después de aceptar ADR-030 y ADR-031. En el DAG, el gate ADR-032 depende de esos gates; al crear tasks, la primera edición de `src/server/http.mjs` para derivar schemas desde el manifiesto y completar su conformance debe quedar aceptada antes de desbloquear cualquier task de extracción HTTP. Esas fases tocarían el mismo módulo y `test/server-http.test.mjs`, por lo que sus gates por sí solos no bastan para serializar tareas.

## Decisión

1. Mantener `src/server/http.mjs` como composition root y facade estable sobre `node:http`. Conserva `createRemoteApiServer` y `PROTOCOL_VERSION` desde el import path público actual; no se añade un framework ni un segundo server factory.
2. Extraer responsabilidades mecánicamente en módulos internos:
   - `src/server/http/codec.mjs`: errores/envelopes HTTP, headers, JSON y path/body decoding.
   - `src/server/http/operations.mjs`: validación superficial HTTP y dispatch de operaciones/batch usando la source completa inyectada por la fachada y la proyección remote-v1.
   - `src/server/http/reads.mjs`: matching/parsing de read routes y adaptación de query/DTO sobre proyecciones puras; recibe snapshot y dependencias, no accede a storage.
   - `src/server/http/transfers.mjs`: validación tipada y dispatch mediante `captureTransferSource`/`installTransferDestination` desde `kernel/transfer.mjs`.
3. La fachada es la única composición de dependencias: crea el server, conecta auth/scope/catálogo, inyecta registry/mutate/policy, conserva `init`, abre el proyecto autorizado, carga snapshots donde hoy corresponde y serializa errores no capturados. Ningún módulo extraído abre/provisiona proyectos, carga configuración global ni lee storage.
4. Preservar la secuencia observable: parsear URL/versión/ruta; validar body/query según ruta; validar bearer/scope/catálogo; abrir o provisionar el proyecto autorizado; ejecutar handler; serializar resultado/error. Los requests malformados siguen fallando antes de auth/opener donde hoy ocurre; auth sigue antes de abrir state/ledger/lock.
5. `PROTOCOL_VERSION` tiene una sola definición (en la fachada, que mantiene su export público). La fachada pasa su valor explícitamente a las funciones del codec que generan headers; el codec no importa `http.mjs`, no duplica el literal `"1"` y no crea ciclo. La constante del cliente remoto no se mueve en este ADR.
6. El boundary test de imports es intencionalmente estrecho: todos los módulos bajo `src/server/http/` no importan `src/storage/`; `transfers.mjs` solo alcanza persistencia por los puertos de `kernel/transfer.mjs`. El test no prohíbe `readState` en `src/server/http.mjs`, que conserva el seam de snapshot de la fachada, y no impone un límite global `server -> storage`.
7. La extracción no cambia auth, origin binding, catálogo, schemas, status de respuesta, errores, headers, límites, payloads de transferencia, comportamiento de `init`, logs ni protocolo wire. Si una caracterización revela comportamiento sin probar, se fija primero tal como existe; un cambio de semántica requiere una decisión aparte.

## Consecuencias

- A favor: `http.mjs` queda más pequeño y la validación/transporte/reads/transfers adquieren límites internos explícitos sin cambiar API pública.
- A favor: transferencias continúan bajo el kernel, mientras la fachada conserva el único seam de apertura/lectura de proyectos.
- A favor: la extracción serial y sus tests localizados facilitan revisión y rollback conceptual.
- En contra / deuda: la fachada sigue siendo responsable de varias dependencias transversales y el servidor aún tiene adaptación HTTP propia.
- En contra / deuda: B y C bloquean partes de D; no se puede extraer reads/operations en paralelo a sus owners.

## Plan de implementación

1. **Caracterizar contrato HTTP** — archivos: `src/server/http.mjs`, `test/server-http.test.mjs`. Congelar exports públicos, todos los headers observables (`x-climier-protocol-version`, `content-type`, `content-length` cuando se envía y `cache-control`), errores/envelopes y orden frente a auth/opener, status/query, operaciones, batch, transferencias e init. Añadir casos de JSON inválido (`INVALID_JSON`/400), Content-Type no soportado (`UNSUPPORTED_MEDIA_TYPE`/415), body sobre 1 MiB (`REQUEST_TOO_LARGE`/413), path encoding inválido en project id (`INVALID_PROJECT_ID`/400) e IDs de read routes (`INVALID_REQUEST`/400). Comprobar en cada caso que el rechazo precede a auth/opener; matriz adicional con bearer ausente/inválido y `openCount=0` mantiene los errores de auth y evita retrasar validación. Estos tests fijan la conducta actual y no amplían protocolo.
2. **Extraer codec** — archivos: `src/server/http.mjs`, `src/server/http/codec.mjs`, `test/server-http.test.mjs`. Pasar `PROTOCOL_VERSION` desde la fachada, conservar sus exports y probar headers de éxito/error y rechazo de versión, sin import circular.
3. **Extraer transfers** — archivos: `src/server/http.mjs`, `src/server/http/transfers.mjs`, `test/cli-transfer.test.mjs`, `test/kernel-transfer.test.mjs`, `test/server-http.test.mjs`, `test/server-operations-e2e.test.mjs`. Las rutas HTTP de transferencia viven hoy en `test/server-http.test.mjs` y esa suite las conserva; `test/server-operations-e2e.test.mjs` cubre el flujo server/remoto integrado. Ampliar el boundary test a la nueva ruta; comprobar source activo, payload inválido y resultado/auditoría por los kernel ports.
4. **Extraer operations** — después de la integración y aceptación de la task de manifiesto/conformance del server bajo ADR-031 — archivos: `src/server/http.mjs`, `src/server/http/operations.mjs`, tests HTTP/manifest. Mantener schema estricto, `core.batch`, source server-side y validación antes de project opener.
5. **Extraer reads** — después de ADR-030 — archivos: `src/server/http.mjs`, `src/server/http/reads.mjs`, tests HTTP/read-model/status/context. Pasar snapshot, query, route, clock y dependencias explícitas; no importar storage desde el módulo extraído.
6. **Cerrar la extracción** — confirmar fachada sin lógica privada duplicada y ejecutar suites completas aplicables. Todos los slices se implementan en serie porque comparten `http.mjs`; crear dependencias explícitas entre tasks para que ninguna extracción comience antes de aceptar la integración del manifiesto al server.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — revisar símbolos/line ranges actuales y concretar los tests de caracterización antes de crear una task por slice; confirmar dependencias ya resueltas de ADR-030 y ADR-031.
- [ ] No hace falta —

## Verificación

- `test/server-http.test.mjs` prueba comportamiento público antes y después de cada slice: `createRemoteApiServer`, header/export `PROTOCOL_VERSION`, mismatch 426, errores/envelopes, requests inválidos antes de auth/opener, reads, operations/batch, transfer e init.
- Tests explícitos fijan JSON malformado/400, Content-Type/415, body limit/413, project-id y read-ID percent-encoding con sus códigos actuales, orden de parse/auth y `openCount=0`; los tests de success/error fijan `content-type`, `content-length` cuando presente, `cache-control` y protocol header. No se normalizan ni sustituyen los dos decoders existentes; se conservan `INVALID_PROJECT_ID` y `INVALID_REQUEST` según ruta.
- `test/architecture/import-boundaries.test.mjs` se extiende (hoy no cubre `src/server/`) como criterio de cada extracción: una vez creado un módulo bajo `src/server/http/`, el test extendido lo inspecciona, rechaza imports de `storage/` y comprueba que `transfers.mjs` importa/llama los puertos `captureTransferSource` e `installTransferDestination` de `kernel/transfer.mjs`. Permite explícitamente `readState` en la fachada y no restringe otros módulos de `server/`.
- `test/cli-transfer.test.mjs`, `test/kernel-transfer.test.mjs`, las rutas HTTP de transferencia en `test/server-http.test.mjs` y `test/server-operations-e2e.test.mjs` cubren puertos, auditoría y comportamiento integrado.
- Read parity usa snapshot y clock fijos; la suite HTTP/manifest conserva campos y rechaza requests hostiles.
- Al cerrar: `npm test`, `npm run test:concurrent`, `npm run pack:check` y `git diff --check`. Oxlint 1.85.0 reportó como baseline informativo 2.231 errores (0 advertencias) en 281 archivos; `npm run lint` termina con código 1, no lo ejecuta CI y ese resultado no bloquea este ADR. No se ejecutan autofixes ni se reduce el baseline bajo esta decisión.
