# RFC: primer contrato Remote v1 y metadata sin marcador de protocolo

> **Histórico / reemplazado en boundary de red:** este RFC conserva el plan del
> corte del wire y la metadata para trazabilidad. Sus referencias a loopback y
> al opt-in HTTP son históricas; ADR-051 y ADR-052 definen el contrato vigente:
> el operador decide bind/transport y el cliente emite warnings no bloqueantes.

- Gate: `G-remote-v1-cut-rfc` · Iniciativa: `remote-cloud-service` · Estado: histórico / reemplazado
- Autor: orchestrator · Fecha: 2026-10-05

## Problema

El cliente y el servidor llaman `v2` al contrato remoto en las rutas `/v2`, el header `X-Climier-Protocol-Version`, el manifiesto de capacidades y `backend.protocol` en `.climier.json`. Esa numeración procede de iteraciones durante la construcción, no de la decisión del producto: el usuario confirma que acepta descartar ese contrato de desarrollo y publicar el contrato actual como el primer Remote soportado. El metadata por checkout debe señalar el tipo de backend y su URL, sin seleccionar una versión del protocolo.

El usuario ya tiene configurado y usa un remote de desarrollo; por ello el corte debe tratarse como una actualización coordinada de cliente y servidor, sin compatibilidad con el contrato anterior. El cambio no debe alterar `project_id`, DAG, ledger, perfil de credenciales ni datos del server. El `backend.url` actual es una URL HTTP no-loopback: el contrato de red existente se conserva y el smoke remoto debe usar una ruta confiable.

## Propuesta

Declarar el contrato remoto actual como **Remote v1**, primer protocolo soportado:

- Todas las rutas remotas de cliente y servidor usan `/v1`. El cliente envía `X-Climier-Protocol-Version: 1`; el servidor exige ese valor antes de autenticar, abrir o provisionar un proyecto y devuelve el mismo header `1` en las respuestas, incluidos errores. El server devuelve `426 PROTOCOL_VERSION_UNSUPPORTED` si falta o no coincide el header. La ruta y el header se mantienen como handshake fail-closed y deben coincidir con la única constante `PROTOCOL_VERSION = "1"`. No se sirven rutas `/v2` en paralelo.
- El manifiesto actual se renombra a manifiesto Remote v1 y declara `version: 1`. Sigue siendo una proyección de capacidades remotas del catálogo canónico, no un catálogo nuevo de operaciones.
- La configuración remota queda como `backend: { type: "remote", url }`; se eliminan `backend.protocol` y cualquier requisito de `protocol: "v1"`. Se mantienen el campo superior `version`, `project_id`, `type` y URL. `link` siempre escribe la forma nueva y conserva el `project_id` existente.
- Una configuración vieja que todavía tenga cualquier propiedad `backend.protocol` falla en comandos normales con `REMOTE_CONFIG_OUTDATED` y sin fallback local. La limpieza explícita es `climier link <URL-remota-configurada>`: no requiere `--replace=true` solo cuando coincide la URL normalizada completa, incluido base path; no basta con compartir scheme/host/port. Preserva URL, `project_id` y metadata ajena, y solo reescribe el campo backend sin `protocol`. `link` no migra ni transfiere DAGs, no cambia el perfil de credenciales y no contacta al servidor para realizar esta limpieza. La prueba debe verificar que el state local y el remoto no cambian.
- La versión del wire queda separada de la versión del paquete y del schema de `.climier.json`. Una futura versión mayor del wire requiere incompatibilidad real; los cambios compatibles permanecen en v1.
- Se conserva el comportamiento actual no relacionado con el corte: login de contraseña y bearer, perfil local indexado por origin, autenticación/autorización, operaciones, `init`, transferencias manuales de ADR-044, ledger/fence, errores remotos y regla de no fallback.

Metadata esperado:

```json
{
  "version": 1,
  "project_id": "<id existente>",
  "backend": {
    "type": "remote",
    "url": "https://climier.example.test/"
  }
}
```

Para limpiar metadata ya versionado, usar `climier link <URL-remota-configurada>` con la URL completa normalizada, incluido cualquier base path; si cambia cualquier parte de la URL se requiere `--replace=true`. La limpieza no requiere `--replace` cuando la URL completa coincide; `project_id` permanece idéntico. El comando no mueve estado local ni remoto ni credenciales. Un origin HTTP no-loopback sigue requiriendo `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true`; un port-forward debe enlazarse como `http://127.0.0.1:<puerto-local>` y requiere login para ese origin distinto.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| **A — Mantener Remote v2** | No requiere cambiar rutas ni clientes/servidores de desarrollo ya desplegados | Publica como segunda versión un contrato que el usuario considera parte de la construcción; conserva el marcador redundante en metadata y da una señal confusa con Climier 1.0. |
| **B — Reetiquetar como Remote v1 y quitar `backend.protocol` (recomendada)** | Hace que el primer contrato soportado sea v1; simplifica metadata; permite desechar el wire de desarrollo con un corte coordinado | Requiere desplegar cliente y servidor juntos; una versión vieja no hablará con la nueva. |
| **C — Eliminar toda versión del wire** | No expone números de protocolo en rutas ni headers | Debilita el diagnóstico y el rechazo explícito ante una incompatibilidad cliente/servidor; rutas sin versión pueden reinterpretarse accidentalmente. |
| **D — Servir `/v1` y `/v2` en paralelo** | Permite transición gradual entre despliegues coexistentes | Mantiene vivo el contrato de construcción, duplica superficie y pruebas de seguridad, y contradice el corte sin compatibilidad aceptado por el usuario. |

## Alcance

- Dentro:
  - **Wire y servidor/cliente:** prefijo `/v1`, header request/response `1`, constante y error de protocolo; eliminar el routing `/v2`. Owner principal: `src/server/http.mjs`, `src/server/http/codec.mjs`, `src/server/http/operations.mjs`, `src/application/backend-remote-transport.mjs`, `src/application/backend-client.mjs`, manifiesto y sus imports.
  - **Metadata y routing de link/transfer:** retirar el marker en `src/application/backend-config.mjs`, `src/cli/commands/link.mjs`, `src/application/manual-transfer.mjs` y `.climier.json`. El guard de transfer debe discriminar por `backend.type === "remote"`; el handshake HTTP, no metadata, rechaza wire incompatible.
  - **Pruebas e integración:** config/link, cliente, reads/writes, login/init, servidor HTTP, errores, transferencias, no-fallback, E2E, fixtures, `scripts/smoke-packed.mjs` y checks de superficie. Casos obligatorios: metadata nueva sin marker funciona; metadata vieja falla en comandos ordinarios sin tocar local; `link` sobre la misma URL normalizada completa limpia marker y conserva ID; `push`/`pull` funcionan sin marker; `/v1` + header 1 funciona; header ausente/incorrecto falla antes de I/O; `/v2` no queda servido.
  - **Docs y operación:** README, referencia, cheatsheet, runbook y notas de protocolo en ADR-043/044 sin retirar sus otras decisiones. Documentar actualización y rollback emparejados, conservando state, ledger, auth store y `project_id`.
  - **Despliegue del remote existente:** detener todos los clientes/escritores viejos, incluido el CLI estable separado que cura el control plane; respaldar metadata, artefactos y datos; actualizar server y clientes durante una misma ventana sin modo dual; relinkear la URL completa para quitar el marker. Antes de enviar password/bearer, verificar por canal administrativo el hash/build del server activo y que listener/proxy no conserva upstream/alias del prototipo histórico `/v1`, cuyo header `1` no se puede distinguir solo en el wire. El E2E automatizado prueba login/lectura/mutación de dos clientes sobre un server y `project_id` temporales aislados; el smoke live del proyecto activo es read-only. Si falla, detener writers, revertir juntos server/cliente estable y restaurar metadata `protocol: "v2"`; comparar hashes y no restaurar ni rebajar DAG/ledger/auth.
- Fuera:
  - Cambiar password/bearer, scopes, perfil de credenciales, actor de auditoría, operaciones disponibles, transferencias, ledger/fence, schema del DAG, permisos o límites de red.
  - Añadir compatibilidad dual, migración de datos o fallback local para requests remotos fallidos.
  - Borrar o renumerar versiones ajenas al protocolo (API de plugins, schema local o versión del paquete).
  - Cambiar un endpoint HTTP por un transporte SSH. `ssh-agent` autentica operaciones SSH; no cifra por sí mismo requests HTTP.

## Criterios de aceptación

- `backend: { type: "remote", url }` se valida y funciona. Si aún existe cualquier propiedad `backend.protocol`, los comandos ordinarios fallan con `REMOTE_CONFIG_OUTDATED` antes de leer o escribir state local/remoto y sin fallback. `link <misma-URL-normalizada>` no requiere `--replace`, quita el marker y preserva `version`, `project_id`, URL, metadata ajena y estado de ambos lados; si cambia base path u otro componente, exige `--replace=true`.
- Todos los endpoints activos usan `/v1`; `PROTOCOL_VERSION`, request header y response header valen `1`; el server rechaza header ausente o incorrecto con `426` antes de abrir/provisionar storage. No queda endpoint `/v2` operativo. Los tests verifican login, reads, writes, init y transferencias bajo el contrato v1.
- Las pruebas de `push`/`pull` cubren metadata remota sin marker, autenticación y error de protocolo fail-closed. Los fallos remotos nunca consultan ni mutan state local por fallback.
- E2E automatizado, contra server temporal: dos clientes linkeados al mismo `project_id` temporal inician sesión, uno lee/muta y el otro observa el cambio; los sentinels locales permanecen intactos; el DAG y ledger del fixture conservan continuidad. En el endpoint live del proyecto activo solo se permite smoke read-only; no crear tasks ni cambiar su DAG.
- Pasan `npm test`, `npm run surface:check`, `npm run smoke:pack` y `git diff --check`. El smoke con el endpoint real se ejecuta solo tras confirmar un transporte/ruta confiable para password y bearer.
- Runbook cubre ventana coordinada, preflight del binario y proxy, actualización del CLI estable y server, relink, smoke live read-only y rollback emparejado. Un fallo restaura los binarios y `.climier.json` respaldados; se comprueba que DAG, ledger, auth store y perfil local no cambiaron, sin restaurarlos ni migrarlos.

## Riesgos y mitigaciones

- **Despliegue desparejado:** un cliente v1 no funciona contra el server de desarrollo que solo atiende `/v2`. El prototipo anterior también usó `/v1` y header `1`; retirar su listener/upstream y verificar el build esperado por canal administrativo antes de enviar credenciales. Detener clientes/escritores viejos y desplegar el par en una ventana; rollback conjunto, nunca modo dual.
- **HTTP y SSH:** el metadata actual apunta a HTTP no-loopback; `ssh-agent` por sí solo no cifra ese tráfico. Para un port-forward local, usar la URL `http://127.0.0.1:<puerto-local>`; al cambiar el origin, hacer login para el origin local porque el perfil de credenciales está indexado por origin. Si se mantiene HTTP directo no-loopback, el opt-in `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true` sigue siendo requerido en cada comando y la red completa debe ser confiable.
- **Otros clones:** un clone con cualquier propiedad `backend.protocol` debe ejecutar `link <URL-remota-configurada>` antes de comandos normales. La URL debe ser la normalizada completa; la acción conserva el ID y no transfiere datos.
- **Historia vs superficie activa:** ADRs antiguos describen contratos históricos Remote v1 y existen otros usos de “v2” no relacionados → cambiar solo consumidores/documentación de la superficie vigente y conservar la historia y los contratos ajenos.

## ADRs derivados

- [x] ADR-045: protocolo HTTP Remote v1 y corte coordinado de `/v2` → `.adrs/045-remote-v1-wire-protocol.md`
- [x] ADR-046: metadata remota sin `backend.protocol` y limpieza por `link` → `.adrs/046-remote-backend-metadata.md`
