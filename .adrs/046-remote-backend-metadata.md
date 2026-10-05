# ADR-046: metadata remoto sin `backend.protocol` y limpieza por `link`

- Gate: `G-remote-backend-metadata-adr` · Deriva de: `G-remote-v1-cut-rfc` · Estado: borrador
- Fecha: 2026-10-05

## Contexto

El checkout usa `.climier.json` para guardar la identidad estable del proyecto y seleccionar el backend. La configuración remote actual también persiste `backend.protocol: "v2"`, aunque la versión de wire es parte del contrato del binario/server y no una opción de transporte que cada repo deba fijar. El usuario aprueba retirar ese marker de los checkouts; el primer contrato HTTP soportado es Remote v1 según ADR-045.

El metadata del checkout ya está configurado contra un servidor en uso. Hay que retirar el marker sin cambiar el URL remoto completo, `project_id`, perfil de bearer o ningún estado. Una configuración antigua debe tener un camino de limpieza explícito, no reinterpretarse silenciosamente ni redirigir al backend local. El CLI estable usado para coordinar este proyecto es un binario separado en `climier-control`; la metadata activa de este checkout no se debe limpiar dentro de un task/merge intermedio mientras ese binario siga siendo v2.

## Decisión

1. **Forma canónica:** para remote, `.climier.json` conserva el schema superior y `project_id`; `backend` contiene exactamente `type: "remote"` y `url`. `backend.protocol` no se persiste ni se requiere. La ausencia de objeto `backend` continúa seleccionando backend local.

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

2. **Configuración antigua:** si un comando normal encuentra cualquier propiedad `backend.protocol`, falla con `REMOTE_CONFIG_OUTDATED` antes de acceso local o remoto y nunca hace fallback. El error muestra el `backend.url` configurado completo (incluido cualquier base path) y un comando de limpieza inequívoco `climier link <URL configurado>`; no presenta la ruta como una actualización de versión. No se infiere compatibilidad desde `v1` ni `v2`.
3. **Limpieza explícita:** `climier link <mismo-URL>` es idempotente sin `--replace=true`; “mismo” significa la URL normalizada completa, incluido su base path, no solo el origin (scheme/host/port). Reemplaza solo el objeto `backend` por `{type: "remote", url}` y conserva `version`, `project_id` y propiedades top-level ajenas. No crea backend client ni contacta al server; solo lee/escribe `.climier.json`, sin cambiar DAGs, ledgers, perfiles de credenciales ni datos remotos. Cambiar cualquier parte de la URL normalizada requiere `--replace=true` según el contrato de `link` vigente. `dispatch` debe enviar `link` al adapter metadata-only antes de `addBackendContext`; quitar del parser el bypass basado en `process.argv`.
4. **Configuración nueva:** `link <origin>` genera un ID solo cuando falta, conserva uno existente y nunca escribe `backend.protocol`. El `type` no se elimina: la versión se retira, no la discriminación local/remota.
5. **Transferencias:** `src/application/manual-transfer.mjs` acepta la selección por `backend.type === "remote"`; deja de inspeccionar `backend.protocol`. Compatibilidad de wire y auth se valida en el backend client/handshake Remote v1, no en metadata. Auth, fallo de protocolo o red siguen fallando sin fallback local.
6. **Seguridad/credenciales:** se conserva la validación de HTTP(S), el rechazo de userinfo/query/secrets y el opt-in explícito actual para HTTP no-loopback. El error de relink indica que HTTP no-loopback requiere `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true`. El perfil bearer sigue indexado por origin. Al cambiar a un port-forward, se debe enlazar `http://127.0.0.1:<puerto>` y volver a hacer login para ese origin; `ssh-agent` no cifra requests HTTP directas, solo el tráfico que efectivamente cruza el túnel. `link` nunca transporta tokens.
7. **Activación/rollback del checkout activo:** limpiar el `.climier.json` de este repo es parte del corte live de ADR-045, no de un merge de código intermedio. Durante la ventana, actualizar primero el CLI estable separado para que sea v1, ejecutar `link` con la URL completa ya configurada y después cambiar el server según ADR-045. Antes del corte respaldar el archivo exacto; si se vuelve a bins v2, restaurar esa copia porque el CLI v2 rechaza metadata sin `backend.protocol`. Conservar el mismo `CLIMIER_HOME` y el state remoto; no editar esta metadata activa desde un task que el CLI estable v2 todavía necesite finalizar.

## Consecuencias

- A favor: un repo declara dónde está y qué backend usa, pero no pinnea una versión de API que corresponde al cliente y al servidor.
- A favor: los clones nuevos reciben metadata mínima; los antiguos tienen una reparación explícita que conserva la identidad del proyecto.
- En contra / deuda: un checkout viejo falla hasta que se relinkea a la misma URL completa. Durante un corte emparejado el operador debe conservar la URL exacta y garantizar que server/cliente correspondan.
- En contra / deuda: `link` limpia metadata local, no migra una credencial entre origins ni prueba que el endpoint acepte el protocolo actual.
- En contra / deuda: la metadata activa del control plane no puede adelantarse al binario estable; su actualización final queda en el rollout manual, no en un merge antes de la sustitución del cliente.

## Plan de implementación

1. **Parser de backend** — `src/application/backend-config.mjs` y `test/backend-config.test.mjs`. TDD: añadir primero casos que fallen; aceptar `type` + URL sin marker, rechazar cualquier valor de `protocol` con `REMOTE_CONFIG_OUTDATED`, mostrar la URL configurada y conservar validación HTTP(S)/secretos.
2. **Despacho metadata-only y `link`** — `src/cli/dispatch.mjs`, `src/cli/commands/link.mjs`, `src/application/backend-config.mjs`; `test/cli-dispatch.test.mjs` y `test/cli-link.test.mjs`. TDD: demostrar por la CLI pública que metadata vieja puede limpiarse antes de crear backend client; verificar que `link` no crea backend client ni accede al state/remoto, no usa `process.argv` desde el parser, escribe la forma nueva y conserva `project_id`.
3. **Transferencias manuales** — `src/application/manual-transfer.mjs`, `test/application-manual-transfer.test.mjs`, `test/cli-manual-transfer.test.mjs`. TDD: eliminar el guard de protocol v2; cubrir push/pull con backend remoto sin marker y no-fallback ante errores de auth/protocol/network. Este slice no cambia la metadata activa del repo.
4. **Cierre integrado** — las pruebas E2E y `scripts/smoke-packed.mjs` pertenecen en exclusiva al task final de ADR-045, después de ambos slices; validar allí la combinación cliente v1 + metadata sin marker + server v1. No editar el `.climier.json` del control plane en un merge intermedio.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — parser/link/dispatch/transfer tiene ownership distinto de wire server/cliente. El checkout activo se limpia solo dentro del gate manual de rollout, después de actualizar el binario `climier` estable; hasta entonces se mantiene su `.climier.json` con `backend.protocol: "v2"` para que Flow pueda seguir curando el DAG.

## Verificación

- La metadata canónica remote sin `protocol` crea el backend remote; metadata local sin `backend` mantiene su conducta. Cualquier valor presente en `backend.protocol` hace que un comando normal falle con `REMOTE_CONFIG_OUTDATED`, muestre la URL completa y la instrucción de limpieza, antes de leer state o hacer request, sin fallback.
- Prueba pública de dispatch: con metadata vieja y `link <misma URL normalizada>` sin `--replace=true`, `link` llega al adapter antes de backend selection; un `backendClientFactory` espía confirma cero llamadas y sentinel/spy confirma cero acceso a state/remoto. La prueba garantiza que el parser no consulta `process.argv`.
- `link` elimina solo `backend.protocol`, preserva `version`, `project_id`, URL y propiedades top-level no relacionadas; repetir es idempotente. Cambiar scheme/host/port/base path requiere `--replace=true`. Mensajes/documentación aclaran el opt-in HTTP no-loopback y que un port-forward usa otra credencial; `ssh-agent` no cifra HTTP directo.
- Ninguna ruta de link/parse cambia state, ledger o perfil de credenciales. Un sentinel confirma que la limpieza solo escribe `.climier.json`.
- `push`/`pull` aceptan backend remoto sin marker y conservan auth/protocol/network fail-closed. Cambiar origin selecciona el perfil correspondiente y requiere login, nunca reutiliza un token de otro origin. La prueba smoke empaquetada combinada pertenece al único owner de ADR-045 y se corre después de ambos slices.
- Rollback live: restaurar el `.climier.json` v2 exacto antes de restaurar/usar el CLI v2; verificar que no se editó state local/remoto ni perfil bearer.
- Ejecutar suites de config/link/transfer, `npm test`, `npm run surface:check` y `git diff --check`; `npm run smoke:pack` se ejecuta solo en el cierre integrado de ADR-045.
