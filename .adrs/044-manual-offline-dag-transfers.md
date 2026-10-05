# ADR-044: transferencias manuales locales/remotas del DAG

- Gate: `G-remote-offline-transfers-adr` · Deriva de: `G-remote-offline-transfers-rfc` · Reemplaza: la exclusión de `push`/`pull` de ADR-043 · Estado: aprobado
- Fecha: 2026-09-30

## Nota de vigencia del wire

ADR-045 supersede únicamente la versión y el prefijo de rutas del wire de
transferencias descritos aquí: el contrato vigente es Remote v1, con `/v1` y
`X-Climier-Protocol-Version: 1`. Se mantienen sin cambios las decisiones de
`push`/`pull` explícitos, CAS, baseline, `--force`, no-fallback, preservación de
claims/plugin data y ledger del destino.

## Contexto

ADR-043 estableció login v2 y el server como única fuente mientras un checkout selecciona backend remoto, pero excluyó transferencias. El usuario requiere alternar explícitamente entre el backend local y remoto: trabajar local cuando no hay conexión y enviar ese DAG al mismo `project_id` más tarde; también descargar el DAG remoto para continuar offline. No pidió fallback automático, merge ni resolución de dependencias.

El requisito supersede solo la decisión de no transferir. Se conservan el password global, login TTY, bearer v2, `link`, HTTPS/proxy TLS, provisioning mediante `init`, eliminación del auth remoto v1 y el rechazo sin fallback. Las transferencias no recuperan la autenticación ni la configuración remota anterior.

## Decisión

### 1. Backend explícito y transferencias manuales

- Sin objeto `backend` en `.climier.json`, los comandos normales usan el state local. Con `backend: { type: "remote", url, protocol: "v2" }`, los comandos normales usan solo el remoto.
- `link <origin>` sigue escribiendo origin + `project_id` en `.climier.json`; no copia DAGs. Quitar `backend` selecciona local; volver a linkear el origin selecciona remoto y conserva el ID. El archivo está versionado: alternar el default afecta a clones solo si se commitea.
- `push` y `pull` vuelven como excepciones explícitas de transferencia. Requieren remote v2 linkeado y login válido. Un error de red/auth/protocolo falla; no redirige ningún comando normal al state local.
- Solo `init` autenticado provisiona un proyecto remoto ausente. Para publicar por primera vez: link, login, `init` remoto y `push`. Un push inicial normal solo reemplaza un remoto prístino recién inicializado.
- Flujo offline: hacer `pull` antes de seleccionar local; quitar `backend` y trabajar local; al reconectar, ejecutar `link` + login y `push`. El marcador de transferencia se conserva fuera del repo bajo `CLIMIER_HOME`.

### 2. Contrato de comandos

- `climier push --as <actor>` copia el snapshot local completo al proyecto remoto con el mismo `project_id`.
- `climier pull --as <actor>` copia el snapshot remoto completo al state local del mismo `project_id`.
- Ambos aceptan la bandera booleana simple `--force` después del comando. `--force=true` no es la forma documentada.
- El éxito devuelve un objeto JSON `{ transfer, project_id, remote_revision, local_revision, forced }`; no expone payload ni bearer.
- Sin force, push falla si el remoto avanzó desde la última transferencia local confirmada; pull falla si reemplazaría un state local cambiado desde la última transferencia confirmada.
- Con `push --force`, el state local completo gana y reemplaza el remoto. Con `pull --force`, el remoto completo gana y reemplaza el local. No hay merge.
- Los errores de conflicto distinguen `TRANSFER_REMOTE_CHANGED`, `TRANSFER_LOCAL_CHANGED` y ausencia de base; incluyen expected/current cuando aplique e indican qué force elige cada lado. Si push falla por avance remoto, pull normal también puede fallar si el local tiene cambios pendientes: `pull --force` elige remoto y descarta esos cambios; `push --force` elige local y descarta el avance remoto.
- Los comandos se marcan EXPERIMENTAL / UNSAFE en help y runbook. Force reemplaza todo el DAG, incluido el historial de destino salvo el evento nuevo de transferencia. Recomendar backup antes de force; no afirmar que el evento restaure el historial borrado.

### 3. Marcador y detección de cambios

El cliente persiste un registro no secreto por origin + project ID bajo `CLIMIER_HOME/remote-transfer-baselines/`, con permisos privados y escritura atómica:

```json
{
  "version": 1,
  "origin": "https://climier.example.com",
  "project_id": "...",
  "remote_revision": 42,
  "local_revision": 19
}
```

- `remote_revision` es la revisión global reportada por el server en el último push/pull confirmado. `local_revision` es la revisión local capturada o instalada durante esa misma transferencia. Los writers canónicos incrementan esas revisiones; edición directa del state file queda fuera del contrato.
- Push con base envía `expected_remote_revision`. El servidor compara esa revisión con el state fresco y reemplaza el snapshot bajo el mismo lock. Un read separado del replace no satisface el CAS.
- Push sin marcador solo se permite a remoto ausente/prístino; en este release `init` crea primero el remoto, por lo que el caso normal de bootstrap es un state prístino. Destino no prístino sin base falla salvo `--force`.
- Pull con marcador exige que la revisión local siga siendo `local_revision`; sin marcador solo acepta state local ausente/prístino. Force salta la comparación de destino, pero mantiene lock y ledger.
- El marcador se actualiza después de confirmación. Un timeout de push puede dejarlo viejo aun cuando el server aplicó el snapshot; no hay journal ni retry idempotente. El error informa el resultado ambiguo y orienta a pull/inspección antes de reintentar. Force sigue disponible bajo responsabilidad del operador.

### 4. Snapshot, publicación y auditoría

- Se copia el state completo de aplicación: initiatives, nodes (incluidos claims y estados `in_progress`), edges, log y plugin data. Las transferencias son opacas; no ejecutan plugins ni interpretan dependencias.
- `fence_generation`, revisión global/node-local y ledger no se copian como autoridad. El destino mantiene su propio fence/ledger y la instalación rebasa revisiones con las primitivas fenced vigentes.
- El wire v2 es `GET /v2/projects/:id/transfer/export` (sin body) y `POST /v2/projects/:id/transfer/import`. Export responde con `{ payload, revision }`, leídos bajo el mismo lock; import recibe `{ payload, actor, expected_remote_revision?, force? }`. Sin force, una expected revision se valida por CAS; si se omite, solo se admite un destino prístino. Force no lleva expected revision y omite solo esa precondición.
- Export remoto devuelve snapshot + revisión desde una lectura consistente bajo lock. Import aplica validación y CAS bajo el lock del destino, con una publicación state+log atómica; la respuesta incluye la nueva revisión remota.
- La instalación agrega un evento `transfer.push` o `transfer.pull` con actor `--as` y la revisión destino reemplazada. En force, el evento nuevo es parte del log que gana; el log remoto/local anterior se pierde y no se conserva una copia de recuperación.
- El formato wire pertenece a `/v2`; el bearer se obtiene solo del perfil de login asociado al origin configurado. No se leen credenciales manuales ni se implementan rutas v1.

## Consecuencias

- A favor: permite trabajar offline y después transferir el mismo DAG con acciones visibles; no crea sincronización implícita.
- A favor: guardas por revisión evitan overwrite accidental cuando solo un lado cambió; force proporciona la selección explícita del lado ganador.
- En contra: no se combinan cambios divergentes. Un force pierde todo el state del destino, incluido su log y plugin data; el servicio es experimental/no seguro.
- En contra: se necesita un marcador local de revisión y las transferencias pueden tener resultado ambiguo ante timeout. No se ofrecen retry, historial de versiones de DAG, merge ni recuperación del snapshot sobrescrito.
- En contra: claims e `in_progress` viajan como campos opacos y pueden quedar activos en el destino; el operador coordina agentes y origen de trabajo.
- En contra: alternar el backend modifica `.climier.json`, que está versionado. No hay un selector local sin git-diff en esta decisión.

## Plan de implementación y ownership

No iniciar una pieza antes de aceptar su dependencia. Mantener paths exclusivos; los tests de CLI/HTTP negativos de ausencia de transfer se reemplazan por cobertura positiva y se conserva cobertura de auth/no-fallback.

1. **Snapshot y CAS en kernel/storage local** — `src/kernel/transfer.mjs`, `src/storage/transfer.mjs`, tests de transferencia. Captura snapshot completo; instalación local/remota con esperado/prístino/force bajo lock; conservar ledgers destino, revisar evento de auditoría y preservar claims/plugin data. No toca HTTP ni CLI.
2. **Marcador local** — módulo nuevo bajo `src/storage/`, tests propios. Persistir y validar `{origin, project_id, remote_revision, local_revision}` por scope en `CLIMIER_HOME`; atomicidad/permisos; no secretos. Depende del contrato de snapshot/CAS de la pieza 1.
3. **HTTP v2 export/import** — `src/server/http.mjs`, `src/server/http/transfers.mjs`, tests bajo `test/server/http/`. Export snapshot+revision; import expected revision/force; CAS+commit under one project lock; conservar auth v2/protocol y 404 para rutas v1. Depende de 1.
4. **Transport de cliente** — `src/application/backend-remote-transport.mjs`, `src/application/backend-client.mjs`, tests de backend client/transport. Añadir export/import v2 autenticados sin fallback y devolver revisions. Depende de 3.
5. **Adapters CLI `push`/`pull`** — `src/cli/commands/push.mjs`, `pull.mjs`, `src/cli/dispatch.mjs`, help/surface checker y tests CLI. Capturar local, usar marcador, mostrar EXPERIMENTAL/UNSAFE, soportar `--force` posicional y errores accionables. Depende de 2 y 4.
6. **Cierre E2E/documentación** — E2E, README/runbook y smoke empaquetado. Cubre import local inicial, ciclo pull→offline→push, conflicto remoto, ambas fuerzas destructivas, claims/plugins, auth inválida, destino ausente/prístino, timeout sin avance del marcador, ledger, backup y ausencia de fallback. Depende de 5.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — `push`/`pull` son dos direcciones del mismo snapshot, no sync; CAS y marcador son la base mínima para que push sin force detecte avance remoto; el force elige una copia completa. Cortes secuenciales por storage/kernel → marcador → HTTP → transport → CLI → E2E/docs.
- Restricciones confirmadas: conservar claims, `in_progress` y plugin data en el snapshot; no implementar merge, retry/journal, nuevo selector local o provisioning por push.

## Verificación

- `npm test` pasa, junto con suites focales de storage/kernel, HTTP, backend client, CLI, E2E y `git diff --check`.
- Primer push: un remoto `init` prístino recibe snapshot local y queda con un marcador correcto; push normal posterior funciona mientras la revisión remota no cambie.
- Push normal con revisión remota adelantada falla sin mutar ningún lado y su error señala current/expected + opciones. `push --force` reemplaza el DAG remoto, rebasea ledger/revisiones, anota revisión reemplazada y actualiza marcador solo tras confirmación.
- Pull inicial a un state local ausente/prístino instala snapshot + audit event. Pull normal no reemplaza revisión local distinta del marcador. `pull --force` reemplaza todo state local y actualiza el marcador.
- Cambio remoto entre CAS y commit no puede pasar desapercibido; la comprobación y reemplazo usan el mismo lock. Writes locales concurrentes con pull también se rechazan mediante compare bajo lock.
- Marcador está separado por origin y project ID, no contiene credenciales y no avanza ante fallo HTTP/auth/protocolo, persistencia fallida o timeout ambiguo.
- Las copias conservan claims, `in_progress`, plugin data y log fuente; force registra solo el evento nuevo más la revisión anterior, no conserva el log de destino descartado.
- `push`/`pull` sin autenticación fallan; remote desconectado/protocolo incompatible no accede a local como fallback; link y el backend local siguen funcionando.
- `climier push --force` y `climier pull --force` aceptan el switch sin `=true`; el help explica que ambos reemplazan un DAG completo y son experimentales/no seguros.
