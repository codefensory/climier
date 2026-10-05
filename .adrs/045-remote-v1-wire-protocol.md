# ADR-045: protocolo HTTP Remote v1 y corte coordinado del wire de desarrollo

- Gate: `G-remote-v1-wire-adr` · Deriva de: `G-remote-v1-cut-rfc` · Estado: borrador
- Fecha: 2026-10-05

## Contexto

El `.climier.json` activo selecciona el contrato de desarrollo con `backend.protocol: "v2"`; esa metadata no prueba por sí sola qué binario responde en el endpoint. El número se añadió durante el desarrollo y no representa una versión anterior que el producto deba soportar. El usuario acepta desechar ese contrato de construcción y lanzar el contrato vigente como el primer Remote público, sin modo de compatibilidad.

Hubo también un prototipo anterior que usó `/v1`. Su número no le da compatibilidad con este contrato: el prototipo está retirado y no se admite. La configuración de un checkout no demuestra qué binario está ejecutando el endpoint; antes de enviar credenciales al endpoint del corte, un operador debe usar un canal administrativo confiable para verificar el hash/build del proceso actual y revisar que el proxy/listener no conserve un upstream o alias del prototipo. El número/header `1` no distingue los dos binarios.

El cambio es de routing/handshake HTTP. No cambia la semántica de auth, operaciones, transferencias, project catalog, proyectos, DAG, ledger/fence ni auth store. El cliente y el servidor deben instalarse como un par; no se sirve `/v1` y `/v2` simultáneamente. Se incluye todo cliente escritor, también el CLI estable usado por el control plane: este checkout lo resuelve actualmente a un binario separado en `climier-control`, que no se actualiza al cambiar este repo.

## Decisión

1. **Identidad de wire:** el único protocolo soportado pasa a ser la versión string `"1"`. `src/server/http.mjs` mantiene la única constante pública server-side `PROTOCOL_VERSION = "1"`; el cliente expone `REMOTE_PROTOCOL_VERSION = "1"`. Las pruebas protegen que no aparezcan definiciones duplicadas.
2. **Rutas:** login es `POST /v1/auth/login`; operaciones, lecturas, init y transferencias conservan sus rutas y payloads actuales bajo `/v1/projects/:project_id/...`. Ninguna ruta `/v2` se mantiene como alias. Un path `/v2` responde `404 ROUTE_NOT_FOUND`.
3. **Handshake request/response:** cada request a una ruta reconocida `/v1` requiere exactamente `X-Climier-Protocol-Version: 1`, incluso login. Ausencia o diferencia falla con HTTP 426 y `PROTOCOL_VERSION_UNSUPPORTED` antes de auth, apertura/provisioning de proyecto o mutación. Toda respuesta, incluidos errores, declara `X-Climier-Protocol-Version: 1`. El cliente valida primero el header de respuesta (antes de leer el envelope o interpretar el status HTTP), también ante 401/404/500; un header ausente o distinto falla con `PROTOCOL_VERSION_UNSUPPORTED` y nunca dispara fallback.
4. **Manifiesto de capacidades:** renombrar `remote-v2-manifest` a `remote-v1-manifest` y fijar `version: 1`. La proyección conserva las mismas operaciones, campos HTTP y elegibilidad de batch; no altera el catálogo canónico ni los providers.
5. **Compatibilidad y datos:** no implementar dual serving, alias ni migración de estado. El server/client del prototipo Remote v1 anterior y los bins v2 de desarrollo quedan fuera de soporte. No se cambia ni reescribe el DAG, ledger/fence, auth store, perfil local de credenciales, `project_id` o URL por esta decisión.
6. **Semántica preservada:** password login y bearer, aislamiento/autorización actual, reads, writes, `core.batch`, init, transferencias manuales de ADR-044, errores estructurados y no-fallback siguen iguales. Eliminar `backend.protocol` de metadata y su guard de `push`/`pull` es decisión separada de ADR-046; ambos ADR son requisitos del mismo release, no estados desplegables independientes.
7. **Rollout coordinado:** detener todos los clientes/escritores, incluido el CLI estable del control plane; verificar por canal administrativo el hash/build del server y que proxy/listener no enrute al prototipo `/v1`; respaldar los artefactos del server, cliente estable y `.climier.json` actual. En una única ventana, instalar el cliente v1, limpiar la metadata con `link` (ADR-046), instalar el server v1 y verificar con un cliente de lectura antes de reanudar escritores. Registrar checksums de `dataRoot`/`tasks.json`, revision ledger y `stateHome/remote-auth.json` antes y después. Si falla, detener escritores, restaurar el server y cliente v2 y el `.climier.json` respaldado. Verificar que los checksums de datos coincidan; no restaurar state/ledger/auth como parte del rollback ni ejecutar `init`, `push` o `pull` en el proyecto activo durante el corte.

## Consecuencias

- A favor: el primer contrato Remote soportado se llama v1 y tiene una negociación explícita, sin extender la superficie con compatibilidad que el usuario no necesita.
- A favor: un servidor o cliente v2 no se confunde con el contrato nuevo; los errores de protocolo no producen fallback local.
- En contra / deuda: la actualización es deliberadamente incompatible y requiere una ventana coordinada. El header `1` no distingue el prototipo histórico `/v1`; inspeccionar el build activo y la configuración de proxy por un canal confiable es una precondición con evidencia, no una suposición basada en `.climier.json`.
- En contra / deuda: la implementación en este repo no actualiza automáticamente el binario estable separado que administra el DAG. El rollout debe incluirlo, conservar el mismo `CLIMIER_HOME` y retirar clientes v2/prototipos antes de cambiar el servidor.
- En contra / deuda: mover un deployment entre origins (por ejemplo, de IP remota a un port-forward `127.0.0.1`) cambia el key del perfil de credenciales y requiere un login para el nuevo origin. `ssh-agent` no protege requests HTTP directas.

## Plan de implementación

1. **Server wire v1** — `src/server/http.mjs`, `src/server/http/codec.mjs`, `src/server/http/operations.mjs`; suites `test/server/http/`. Fijar versión en un único owner, prefijos `/v1`, header request/response y orden fail-closed; rechazar rutas `/v2`.
2. **Cliente y capacidades v1** — `src/application/backend-remote-transport.mjs`, `src/application/backend-client.mjs`, `src/application/operations/remote-v2-manifest.mjs` (renombre e imports), tests directos de backend client, CLI remote routing y read-model parity. No cambiar parser de metadata ni auth.
3. **Integración y rollout documentado** — owner exclusivo de `test/server-operations-e2e.test.mjs`, `scripts/smoke-packed.mjs`, README, `CLIMIER-CHEATSHEET.md`, `docs/remote-server.md`, `CHANGELOG.md` y notas de protocolo en `.adrs/043-single-password-remote-server.md` / `.adrs/044-manual-offline-dag-transfers.md`. El E2E arranca un server aislado y dos clientes sobre un `project_id` temporal para probar login/read/mutate, transferencia y continuidad de ledger; el smoke empaquetado valida el par construido. El corte al endpoint real y al CLI estable del control plane es un paso manual, no lo ejecuta Flow ni el smoke.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — paths separables en wire server/cliente, metadata/link/transfer y cierre E2E/docs con ownership exclusivo. El corte real requiere además actualizar el CLI estable separado del control plane por canal administrativo; el smoke de rollout no envía credenciales al endpoint real y no se ejecuta desde Flow.

## Verificación

- Las rutas login, read, operation/batch, init y transfer existen bajo `/v1`; ninguna ruta `/v2` está servida. Cliente/servidor, constantes y request/response header declaran `1`.
- Header `X-Climier-Protocol-Version` ausente o diferente en login/reads/writes/init/transfers devuelve 426 antes de abrir o crear storage. Las respuestas de éxito y error muestran la versión `1`; el cliente rechaza header ausente/distinto antes de interpretar cualquier status o envelope, incluidos los errores.
- Operaciones v1 mantienen sus envelopes, errores, auth, `core.batch`, init, transferencias y rechazo sin fallback. Un sentinel local permanece intacto ante éxito remoto y errores de auth, red y protocolo.
- E2E automatizado en server aislado con dos clientes y un `project_id` temporal: A muta, B observa y se verifica ledger/state; no muta el project_id activo. Ejecutar `npm test`, `npm run surface:check`, `npm run smoke:pack` y `git diff --check`.
- Antes del live cut, registrar y contrastar por canal administrativo hashes del server v2, CLI estable v2, metadata, `dataRoot`/state+ledger y `stateHome/remote-auth.json`; revisar listener/proxy para retirar el prototipo `/v1`. Después del smoke read-only, comprobar hashes de datos/ledger/auth sin cambios.
- Rollback comprobable: detener escritores, restaurar artefactos server/CLI v2 más el `.climier.json` exacto respaldado, confirmar servicio de nuevo en v2 y comparar hashes del DAG, ledger y auth store. No restaurar esos datos como shortcut; no dejar clientes viejos usando un server nuevo.
