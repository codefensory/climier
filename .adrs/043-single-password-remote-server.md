# ADR-043: remote simple con contraseña única por instancia

- Gate: `G-remote-single-server-adr` · Deriva de: `G-remote-single-server-rfc` · Estado: borrador
- Fecha: 2026-09-30

## Contexto

El remote actual tiene tokens estáticos con scopes y una allowlist de IDs en config de servidor. El RFC aprobado fija otro objetivo: una persona opera una instancia propia, proporciona una contraseña general al levantarla y hace login desde sus equipos. Cada login obtiene un token con acceso a todos los DAGs de esa instancia. No hay cuentas, organizaciones, ACL por proyecto ni soporte del mecanismo remote anterior. Véase [RFC](../.decisions/G-remote-single-server-rfc.md).

El server ya es autoridad del estado y opera un DAG por project ID mediante kernel, locks y revision ledger. La persistencia por archivos soporta una instancia en un host con volumen durable, no HA ni escalado horizontal.

## Decisión

### 1. Una instancia, un secreto y autoridad global

- `climier-server` requiere `CLIMIER_SERVER_PASSWORD` al inicio. No acepta el secreto en argv ni lo escribe en config pública, stdout, stderr o logs. Para producción se inyecta desde un secret manager o archivo de entorno privado del servicio.
- El password debe ser de alta entropía. El server lo convierte a un verifier con `scrypt`; el login compara en tiempo constante. El listener solo puede bindear a loopback. El cliente rechaza HTTP no-loopback; el acceso externo usa un reverse proxy TLS de confianza que reenvía solo la API Climier. Se elimina el opt-in anterior de HTTP remoto plaintext.
- Un intento correcto en `POST /v2/auth/login` emite un bearer aleatorio para ese login. No se modelan usuarios ni identidad de sesión: cualquier bearer válido puede operar cualquier proyecto, y `--as` sigue siendo actor de auditoría declarado por el cliente.
- Antes de inicializar auth o escuchar, el runtime toma `stateHome/.server.lock` con creación exclusiva y lo mantiene durante la vida del servicio. Una segunda instancia con ese `stateHome` falla con `SERVER_ALREADY_RUNNING`. El lock guarda PID/inicio; el cierre normal libera el lock; un crash deja lock stale que no se elimina automáticamente. Recovery: confirmar que el PID/servicio murió, respaldar `stateHome`, eliminar solo ese lock y reiniciar. Una prueba levanta dos procesos y verifica que solo el primero escucha.
- El server guarda en `stateHome/remote-auth.json` el password verifier y hashes de bearers con expiración (nunca tokens en claro). Se crea con permisos privados (`0700` directorio, `0600` archivo en POSIX). Updates serializados con una cola/mutex in-process bajo el lock de servicio: temp file `0600`, write+fsync del archivo, fsync del directorio, rename atómico y fsync del directorio antes de responder/escuchar.
- Primera inicialización crea el verifier y una lista de sesiones vacía. Un login añade el hash de un token aleatorio con vencimiento a 30 días; el token solo se devuelve después de persistirlo. Arrancar con el mismo password conserva sesiones; si el password configurado cambia, se persisten verifier nuevo y lista vacía antes de escuchar, revocando todos los bearers anteriores. Si el archivo falta, se crea auth nueva y los tokens guardados por clientes dejan de ser válidos; si está corrupto, el server falla cerrado.
- Un fallo/crash antes del rename conserva el auth anterior; un fallo después del rename no habilita al server a escuchar antes del fsync del directorio. Si una rotación no termina, reiniciar con el password nuevo vuelve a completar la rotación antes de aceptar requests, por lo que el bearer viejo no se valida.
- Recovery de auth corrupta: detener el servicio, respaldar `stateHome` y el auth file corrupto, apartar solo `remote-auth.json` y reiniciar; esto crea auth nueva, mantiene intactos los DAGs y exige login otra vez en cada cliente. Nunca borrar state, ledger o project data como parte de esta recuperación.
- Cada request valida el hash del bearer contra sesiones no expiradas con comparación constant-time. `climier logout` borra la copia local, no revoca el hash del server; las sesiones se eliminan al vencer o al rotar password. No hay revocación individual por dispositivo ni identidad de usuario.
- El endpoint de login limita cinco fallos consecutivos por dirección de cliente durante 15 minutos; un login correcto limpia el contador. El reverse proxy de confianza debe sobrescribir la dirección forwarded; el server solo usa ese valor si el peer socket es loopback y nunca lo confía desde conexiones directas no-loopback. El límite y `AUTH_RATE_LIMITED` son observables y testeados.

### 2. Login CLI y perfil local

- `climier login [--server <origin>]` resuelve el server del checkout actual si se omite `--server`; si no hay checkout linkeado, exige el origin explícito. Solicita el password por TTY sin eco y lo envía por HTTPS. No admite contraseña en argv, env, URL ni stdin en v1. Sin TTY falla antes del request con `INTERACTIVE_LOGIN_REQUIRED`.
- Tras autenticarse, el cliente persiste solo el bearer de esa sesión, indexado por origin, en un perfil local fuera del repo (por defecto bajo `~/.climier/`, permisos `0700`/`0600` en POSIX). La escritura falla en voz alta; no se informa login exitoso si el token no quedó guardado. No hay nuevas dependencias de runtime. `climier logout [--server <origin>]` borra el token local; no lo revoca en servidor.
- Remote usa exclusivamente el bearer del perfil local asociado al origin configurado; las credenciales no se copian a `.climier.json`. Errores de auth, red o protocolo nunca leen/escriben el DAG local como fallback.
- El prompt y la entrada secreta usan el TTY sin eco; el password no aparece en argv, env, stdin, stdout, stderr ni logs. El resultado del comando sigue siendo un único JSON en stdout y nunca incluye el token.

### 3. Link de checkout y datos de proyecto

- El metadata del proyecto mantiene su `project_id`. El comando plano `climier link <origin> [--replace=true]` conserva un ID existente (también en clones) o crea uno opaco nuevo solo si falta; registra `backend: { type: "remote", url, protocol: "v2" }` y origin no secreto en `.climier.json`. Repetir el mismo link es idempotente. Cambiar el origin de un checkout remoto requiere `--replace=true`; no cambia ni transfiere su DAG.
- La config remota v2 requiere el campo exacto `backend.protocol: "v2"`. Una config remota anterior sin el marker falla con `REMOTE_CONFIG_OUTDATED` antes de auth o I/O local. Ejecutar `climier link` es la acción explícita de relink; preserva el ID, cambia el target solo con `--replace=true` y no migra el state v1 ni copia el DAG local. Si el target nuevo ya contiene ese ID, no lo reemplaza.
- Todos los IDs de proyecto autenticados se resuelven bajo el `dataRoot` privado mediante un nombre hash-safe; el ID nunca se concatena como path. No hay allowlist manual de IDs ni scopes por project ID.
- Solo `climier init` autenticado puede provisionar el directorio/state ausente. Lecturas, operaciones, batch y writes requieren que el proyecto exista; un ID no debe crear storage implícitamente. `init --force`, snapshots/restore y plugins siguen sin soporte remoto y fallan antes de tocar state local.
- No se preservan `push`/`pull`: no hay sync ni transferencias automáticas. Para cada remote link el DAG server-side es la única fuente de verdad; los DAGs v1 existentes permanecen intactos fuera del servicio nuevo. Backend local sigue disponible sin cambios.

### 4. Protocolo y operación

- El cliente y server nuevos usan protocolo HTTP API v2; login va por `POST /v2/auth/login`, sin project ID. Operaciones de DAG llevan ID y bearer v2. El server v1 no satisface este protocolo y el cliente v1 no puede autenticarse contra v2.
- El server config conserva `listen`, `dataRoot`, `stateHome`; elimina `credentials[]` y `projectIds[]`. `listen.host` debe ser loopback; para acceso externo se despliega un proxy TLS local. El cliente rechaza HTTP no-loopback y no honra el antiguo opt-in plaintext.
- El runtime permite una instancia por `stateHome`, bloqueada por `stateHome/.server.lock` desde antes del bootstrap auth hasta shutdown. El lock stale no se roba automáticamente y requiere recovery manual verificado.
- El primer despliegue alojable es single-host con volumen durable. Respaldar `stateHome`, auth file y `dataRoot` de forma consistente; proteger backups como secretos/datos originales. Sin promesa de HA ni backend DB en este cambio.

## Consecuencias

- A favor: ciclo de uso corto (`login` una vez por equipo; `link` una vez por checkout; comandos normales), sin tokens en comandos/env del usuario ni administración central de IDs.
- A favor: cada operador controla su propio server y datos; el proyecto compartido por git solo contiene server origin y project ID no secretos.
- En contra / deuda: password y bearers son autoridad global; no se puede limitar ni identificar personas, y `--as` es falsificable. Rotar password cierra el acceso de todos hasta que vuelvan a hacer login.
- En contra / deuda: auth file contiene hashes de tokens y password verifier bajo permisos del servicio; compromiso del host equivale a compromiso de todos los DAGs. Debe excluirse de copias no protegidas.
- En contra / deuda: single-host filesystem limita HA; cambiarlo a storage compartido requiere una decisión/migración futura que preserve atomicidad state+log, locks, ledger/fence y recovery.
- En contra / deuda: eliminar remote v1 y push/pull es un corte deliberado, sin compatibilidad ni migración de DAGs. Los comandos `push` y `pull` se retiran globalmente porque solo implementan transferencia local↔remote. El backend local no se retira.

## Plan de implementación y ownership

Las tasks se crean en esta secuencia; ningún worker adelanta cambios en paths asignados a una task dependiente.

1. **Auth store y lock de servicio.** Nuevos `src/server/auth/server-auth-store.mjs` y `src/server/service-lock.mjs`, con tests nuevos dedicados. Define password verifier, bearer durable, rotación, fsync/crash contract y lock de vida del server; no toca runtime ni HTTP.
2. **Server v2 y catálogo dinámico** — depende de 1. Owner exclusivo: `bin/climier-server.mjs`, `src/server/runtime-config.mjs`, `runtime.mjs`, `http.mjs`, `http/codec.mjs`, `auth/project-scope.mjs`, `catalog/index.mjs` y nuevo `src/application/operations/remote-v2-manifest.mjs`; tests server HTTP/catalog/runtime. Integra auth, v2 login y operaciones, loopback-only, init create-only y lock durante toda la vida.
3. **Project link/config del cliente.** Owner exclusivo: `src/application/backend-config.mjs`, nuevo `src/cli/commands/link.mjs` y helper de metadata si hace falta, con tests propios. No edita `dispatch.mjs`. Fija `backend.protocol: "v2"`, preservación de ID y `--replace=true`.
4. **Perfil y login/logout CLI** — depende de 2 y 3. Owner exclusivo: `src/application/backend-client.mjs`, `backend-remote-transport.mjs`, nuevo store local de credenciales, nuevos adapters `login.mjs`/`logout.mjs` y sus tests. No edita `backend-config.mjs` ni `dispatch.mjs`.
5. **Wiring y retiro de superficies anteriores** — depende de 2–4. Owner exclusivo: `src/cli/dispatch.mjs`, eliminación de `src/cli/commands/push.mjs`/`pull.mjs`, eliminación del manifest `remote-v1-manifest.mjs` después de que no queden imports, tests de dispatch/surface/help. Registra los comandos planos `login`, `logout`, `link`; elimina `push`/`pull` del CLI globalmente y no mantiene el protocolo v1.
6. **E2E y documentación** — depende de 5. Owner exclusivo: `test/server-operations-e2e.test.mjs`, `README.md`, `docs/reference.md`, `docs/remote-server.md` y docs asociadas; acredita el flujo completo y el runbook de single-host, TLS proxy, backup, rotación y recovery.

Las tasks 1 y 3 pueden desarrollarse en paralelo. La 2 depende de la 1; la 4 de 2 y 3; la 5 de 2–4; la 6 de 5. Las dependencias evitan pisar `dispatch.mjs`, `backend-config.mjs`, `src/server/http.mjs`, manifests y fixtures de integración.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — scope reducido a un password por instancia; login TTY emite bearer sin identidad con acceso a todos los proyectos; `link` es plano, idempotente y preserva IDs al clonar; `init` es el único provisioner; old remote falla explícitamente y no se migran datos. Las tasks tienen ownership secuencial por frontera.

## Verificación

- `npm test` y `git diff --check` pasan; tests focales de auth/catalog/client y `test/server-operations-e2e.test.mjs`.
- Un server configurado con password y listener loopback inicia; falta de password, listener no loopback o auth file corrupto falla antes de escuchar. Dos procesos no comparten un `stateHome`; el segundo falla, el primero libera su lock al cerrar y un lock stale exige recovery manual verificado.
- Password correcto emite bearer aleatorio por login; cada token persistido funciona tras reinicios y vence a los 30 días; incorrecto no lo entrega. Cambiar la contraseña vacía la lista y revoca todos los tokens. Auth rotation fsynca temp file y directorio antes/después de rename y no escucha hasta confirmar la auth durable; fallos/crash antes del commit conservan el auth viejo, y restart con password nuevo completa la rotación antes de aceptar requests. Tokens viejos fallan antes de I/O de proyecto.
- Token accede a todos los project IDs de la instancia; proyectos distintos quedan aislados como DAGs distintos, pero no tienen ACL entre sí.
- Cinco passwords incorrectos de la misma dirección en la ventana fijada bloquean login por 15 minutos; un éxito resetea el contador.
- `climier link <origin>` conserva ID y origin en clones; solo genera ID si falta; el mismo link es idempotente y cambiar origin requiere `--replace=true`; `init` autenticado crea un proyecto; requests de lectura/write a ID ausente no crean storage. Config remota v1 sin `backend.protocol: "v2"` falla con `REMOTE_CONFIG_OUTDATED` sin request.
- Dos clientes con sesión al mismo server: A modifica y B observa; archivos sentinel locales no cambian. Endpoint caído, auth inválida, config remote v1 y protocolo incompatible fallan sin fallback ni envío de credenciales legacy.
- TTY ausente falla antes del request; el password no aparece en argv/env/stdin/stdout/stderr/logs; falla al guardar token no reporta login exitoso; login/logout conservan JSON sin incluir bearer. Logout borra la credencial local; el hash queda activo hasta expiración o rotación global.
- Cliente rechaza HTTP no-loopback y server rechaza binding non-loopback; el runbook demuestra proxy TLS local para acceso remoto. Configs de server con `credentials[]`/`projectIds[]` legacy se rechazan con mensaje accionable.
- Los comandos `push` y `pull` ya no están en `KNOWN_COMMANDS`, help, package docs ni manifest/API v2; llamadas a rutas transfer v1 fallan por ruta/protocolo no soportado.
- El backend local y su contrato JSON mantienen sus pruebas existentes; el servidor remoto no incorpora dependencias runtime.
