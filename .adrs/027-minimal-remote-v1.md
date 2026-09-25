# ADR-027: remote v1 mínimo, operaciones tipadas y transferencias explícitas

- Gate: `G-rb-minimal-v1` · Deriva de: `G-remote-backend-rfc` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

El RFC de backend remoto y los ADR-022 a ADR-026 definieron una dirección correcta: el servidor es la autoridad, el cliente usa una API HTTP(S) tipada y el proyecto remoto no puede caer silenciosamente al DAG local. La primera implementación ya aporta configuración, cliente HTTP, lecturas tipadas, catálogo confinado, auth por proyecto, operaciones canónicas server-side y ledger fenced.

Sin embargo, el contrato acumuló una segunda capa de producto antes de cerrar el flujo básico: journal durable de transferencias, UUID/retry/status, CAS de overwrite, provisioning con una capacidad adicional, restore remoto y validación E2E ligada al host. Al mismo tiempo, algunos mutadores del CLI se anuncian como remotos pero todavía invocan el kernel local. Esta enmienda fija un v1 pequeño que sea seguro, verificable y operable antes de añadir esas garantías avanzadas.

Este ADR complementa, no borra, los ADR-022 a ADR-026. Cuando difiera de su contrato de release, esta decisión prevalece para `remote-backend` v1.

## Decisión

### 1. Autoridad, configuración y autenticación

- Sin `backend` en `.climier.json`, el CLI conserva el backend local.
- Con `backend: { type: "remote", url }`, el cliente usa solo la API HTTP(S) tipada. Auth, red, protocolo o errores del servidor nunca autorizan una lectura o escritura local como fallback.
- El cliente toma la credencial de `CLIMIER_TOKEN` u otra variable/proveedor de secretos explícitamente configurado por el operador. Climier no carga archivos `.env` por sí mismo y `.climier.json` nunca contiene tokens, userinfo ni secretos.
- Antes de adjuntar el bearer, el cliente exige una binding de origen aprobada por el operador fuera del checkout: `CLIMIER_REMOTE_ORIGIN` debe ser exactamente igual a `new URL(backend.url).origin`. Si falta o no coincide, falla sin request autenticado. Un cambio de URL en `.climier.json` no puede redirigir el token; el operador aprueba el origen nuevo explícitamente. La variable solo contiene un origen, no un secreto, y no se versiona.
- El servidor acepta `Authorization: Bearer <token>`. Su configuración privada asocia cada token con los `projectIds` que puede usar. `--as` sigue siendo identidad de auditoría; no es autenticación.
- El servidor solo atiende un `project_id` ya presente en su catálogo confiable. El token debe tener scope de ese proyecto antes de que el servidor cree o abra un directorio, state, ledger o lock.

### 2. Storage server-side y operación

El launcher del servidor recibe configuración privada para un catálogo, una raíz de datos y un `state_home` privados. El catálogo convierte el `project_id` externo opaco en una identidad interna hash-safe; el opener server-side prepara metadata interna de confianza con esa identidad y el proceso usa `state_home` como `CLIMIER_HOME`.

Por tanto, `tasks.json`, `revision-ledger.json`, stages y `.lock` de un proyecto remoto viven bajo storage controlado por el servidor. Ninguna ruta proveniente de la URL, payload o checkout de un cliente determina esos archivos. El launcher, runbook y configuración permanecen stdlib-only y no versionan tokens, hostnames, IPs o paths personales.

### 3. Matriz v1 de comandos

| Superficie | v1 remoto |
|---|---|
| Lecturas built-in (`status`, `context`, `show`, `history`, `search`, `initiatives`, `log`, `state`) | API remota tipada |
| Todas las mutaciones built-in de task, gate, knowledge, initiative, edge y note | Operaciones canónicas tipadas server-side |
| `batch` | Operación `core.batch` tipada, con schema explícito server-side |
| `init` | `POST /v1/projects/:id/init`, solo para un ID ya catalogado y token con scope; crea state remoto ausente; nunca crea DAG local |
| `init --force` | `REMOTE_UNSUPPORTED_OPERATION` |
| `push` / `pull` | Transferencias explícitas básicas descritas abajo |
| `snapshots`, `restore`, UI, namespaces/comandos de plugins y plugin-data | `REMOTE_UNSUPPORTED_OPERATION` antes de cargar handlers o tocar state local |

Un bridge único de operaciones de proyecto vive entre los adapters CLI y la ejecución local/remota. Los adapters siguen validando argv, normalizando input y preservando su envelope público, pero no eligen storage. El bridge:

- en modo local delega una vez a `executeOperation` o `executeBatch` y conserva la policy local;
- en modo remoto delega una vez a `backendClient.executeOperation` o `executeBatch`, sin descubrir plugins, cargar policy local, crear metadata local ni tocar kernel/storage local.

El servidor sigue admitiendo solo un allowlist explícito de operación e input. No recibe argv, providers, policies ni handlers enviados por el cliente. Las policies autoritativas de un proyecto remoto se ejecutan únicamente en el host server-side.

### 4. Init remoto

`climier init` remoto es idempotente solo respecto a un state ausente: crea el state vacío del proyecto catalogado mediante la ruta server-side tipada. Un segundo init devuelve el error estructurado normal de state ya inicializado. El endpoint valida versión de protocolo, bearer token y scope antes de provisionar/abrir storage; no filtra paths y rechaza `force`, `reset` y campos desconocidos antes de I/O.

No existe un permiso separado de provisioning en v1: conocer un proyecto permitido por el catálogo y tener scope de token para él es la autorización de init. Un token nunca registra IDs arbitrarios.

### 5. Push y pull básicos

`push --as <actor> [--overwrite=true]` copia el DAG local al proyecto remoto configurado. `pull --as <actor> [--overwrite=true]` copia el DAG remoto al state local del mismo `project_id`. Son excepciones explícitas: pueden acceder a la copia local aunque el checkout esté configurado remote, pero no cambian la configuración ni crean sincronización implícita.

El transporte es una API de transferencia tipada, no un endpoint genérico para `tasks.json` ni filesystem.

#### Fuente

- La fuente se captura bajo su lock como un snapshot consistente y se libera antes de esperar una operación HTTP. Si es un proyecto fenced, la captura primero recupera pending válido y valida contra su propio ledger, schema y `fence_generation`; ledger ausente, inconsistente, generación/hash regresados o recovery ambiguo fallan cerrado antes de transferir. La fuente no se "corrige" al rebasarla en destino.
- Se rechaza si tiene tareas `in_progress`, claims activos, root plugin data o plugin data en cualquier nodo.
- Se transfieren `nodes`, `edges`, `initiatives` y el log fuente. No se transfieren `fence_generation`, ledger, lock, snapshots, configuración, tokens, plugins/runtime ni revisiones persistidas de nodo/state.

#### Destino

- Sin `--overwrite=true`, el destino debe estar ausente o ser prístino: `nodes`, `edges`, `initiatives`, `log` y plugin data vacíos. Revision, ledger y generación no determinan por sí solos que un state inicializado deje de ser prístino; así `init` remoto seguido de `push` funciona sin otro flag.
- Con `--overwrite=true`, la instalación reemplaza el DAG y log del destino bajo el lock del destino. Es un overwrite absoluto sin CAS en v1: puede descartar cambios, claims o tareas en progreso del destino. El comando debe documentarlo claramente. Un destino con plugin data se rechaza para evitar pérdida silenciosa.
- La instalación usa una operación kernel/storage dedicada y las primitivas fenced existentes. El destino conserva o crea su propio ledger y `fence_generation`, y rebasa las revisiones de state y nodos. Nunca usa `writeState`, snapshots o restore como transporte.
- El destino termina con el log fuente y un único evento auditable `transfer.push` o `transfer.pull`; el log anterior del destino queda reemplazado.

No hay merge, sync, cache offline, journal, UUID, `transfer-status`, retry automático ni promesa de idempotencia. Si un `push` agota el timeout después de que el servidor pudo haber hecho commit, el error es `TRANSFER_OUTCOME_UNKNOWN` con `applied: "unknown"`; el CLI no reintenta. En `pull`, una falla antes de recibir la fuente no escribe localmente.

### 6. Fence y recovery

El ledger/fence v5 ya integrado se conserva. No se añade un segundo protocolo de recovery específico para transferencias: la transferencia delega su publicación en bootstrap/commit fenced existente.

Sí se completa la recuperación ya requerida por ADR-023: `restore` e `init --force` compatibles sobre proyectos fenced deben usar recovery bajo el lock activo, conservar la generación local y rebasar state/nodos. No se permite que estas rutas escriban un proyecto fenced por el writer legacy.

### 7. Validación y Tailscale

La aceptación de release sigue un orden verificable: cada tarea ejecuta su suite focal y la concurrencia aplicable; después `npm test` y `git diff --check` quedan verdes; entonces un E2E local automatizable de dos clientes prueba que A muta, B lee, los sentinels locales permanecen intactos y token inválido/endpoint caído no hacen fallback. Solo después se abre un gate de smoke temporal por Tailscale, manual y con evidencia redactada, sin versionar hostnames, IPs, tokens ni transcript sensible. Ese smoke no sustituye ni bloquea la aceptación automatizada de release.

## Consecuencias

- A favor: entrega una autoridad remota completa para las operaciones built-in sin duplicar lógica de providers/kernel en el cliente; `push`/`pull` permanecen deliberados y entendibles.
- A favor: reduce el riesgo inmediato de la ruta actual, donde comandos anunciados como remotos pueden escribir localmente.
- A favor: reutiliza ledger/locks existentes sin añadir el journal de transferencias ni una semántica de sincronización.
- En contra / deuda: overwrite absoluto puede perder cambios concurrentes del destino; se registra como backlog para CAS con expected revision.
- En contra / deuda: un timeout de push puede requerir inspección manual del destino antes de reintentar.
- En contra / deuda: plugin data, UI, snapshots/restore remotos y extensiones de plugins permanecen fuera de v1.

## Enmiendas a decisiones anteriores

- **ADR-022:** mantiene API HTTP(S), bearer por proyecto y catálogo confinado. Para v1, `init` requiere solo catálogo + scope; no `provisionProjectIds` separado.
- **ADR-023:** mantiene ledger/fence y exige completar recovery fenced de `restore`/`init --force`; no se añade journal de transferencia.
- **ADR-024:** todas las mutaciones built-in y batch pasan por el bridge; plugin APIs/commands siguen no soportados remotamente.
- **ADR-025:** su protocolo completo de transfer ID, journal, status, retry y CAS de overwrite se difiere. V1 usa el contrato básico de esta decisión.
- **ADR-026:** E2E local y runbook son acceptance automatizable; Tailscale es un smoke manual temporal al final, no requisito de infraestructura ni artefacto versionado.

## Plan de implementación

1. Launcher/configuración server-side y binding confiable catálogo → metadata interna → `state_home`.
2. Init remoto tipado, cliente y adapter sin escritura local.
3. Contrato HTTP explícito de `core.batch`.
4. Bridge de operación local/remoto y routing de todas las mutaciones built-in por grupos de ownership.
5. Recovery fenced para state operations y corrección de fixtures/contratos v4/v5 hasta dejar la suite integrada verde.
6. Núcleo de transferencia básica fenced y rutas cliente/servidor + comandos `push`/`pull`.
7. Runbook, suites verdes y E2E local automatizable de dos clientes; solo después, gate separado de smoke temporal por Tailscale con evidencia redactada.
8. Backlog separado: overwrite con CAS/expected revision, journal/retry/status y transferencia de plugin data solo si el producto los necesita.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — se revisaron cliente, HTTP server, catálogo/auth, storage/ledger, adapters CLI y grafo actual. El corte separa runtime server, init, batch, bridge/routing, recovery, transfer, integración y operación para evitar ownership solapado.

## Verificación

- Cada lectura y mutación remota deja intacto un state local sentinel tanto en éxito como en 401, error de protocolo y endpoint caído. Un cambio de `backend.url` sin actualizar la binding de origen del operador falla antes de enviar el bearer al nuevo origen.
- El servidor rechaza auth/scope inválidos antes de abrir/provisionar storage y nunca revela paths.
- `init` remoto no crea state local; `init --force` remoto falla antes de I/O local.
- Todas las operaciones built-in y `core.batch` conservan sus envelopes CLI y se ejecutan por kernel server-side.
- `push`/`pull` cubren destino ausente/prístino, overwrite explícito, fuentes con claims/in_progress/plugins, destino con plugins, auditoría, rebase fenced, carrera create-only, fuente fenced con ledger/generación regresados rechazada antes de transferir y timeout ambiguo de push.
- `restore`/`init --force` locales compatibles reparan proyectos fenced sin bajar ledger/generación.
- `npm test`, las suites focales, concurrencia aplicable y `git diff --check` pasan antes del gate de smoke Tailscale.
