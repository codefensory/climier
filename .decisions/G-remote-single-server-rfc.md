# RFC: remote simple para un servidor propio de Climier

- Gate: `G-remote-single-server-rfc` · Iniciativa: `remote-cloud-service` · Estado: en review
- Autor: orchestrator · Fecha: 2026-09-30

## Problema

El remote actual requiere que cada checkout tenga `backend.url` y `project_id`, mientras cada comando remoto depende de un bearer configurado manualmente. El servidor además mantiene una lista estática de proyectos y tokens. Eso complica el objetivo inmediato: una persona levanta un servidor Climier en su máquina, lo usa desde varios checkouts y comparte una sola contraseña de acceso con quien confíe.

La decisión explícita del usuario es mantenerlo simple: **un servidor administrado por su operador, una contraseña general configurada al iniciar el servicio y un token que el login entrega para acceder a todos los proyectos linkeados a ese servidor**. No se requieren cuentas, organizaciones, roles, membresías, invitaciones, billing ni alta pública. El backend local de Climier se conserva.

## Propuesta recomendada

- El operador proporciona la contraseña general al proceso `climier-server` mediante un mecanismo privado de startup (variable de entorno/secret manager, nunca argumento visible, repo ni log). El servicio rechaza arrancar si falta. La contraseña se verifica con derivación segura (`scrypt`) y comparación constant-time.
- `climier login --server <origin>` pide la contraseña de forma interactiva sin eco en TTY y la envía una sola vez por HTTPS. No acepta el password en argv ni environment. Si es válida, el servidor emite un bearer aleatorio para ese login y la CLI lo guarda fuera del repo, asociado al origin, en un archivo privado del home (`0600` en plataformas POSIX). `logout` borra la copia local.
- El servidor guarda en un archivo privado de auth el password verifier y los hashes/expiraciones de tokens activos, nunca los tokens en claro. Las sesiones sobreviven reinicios y vencen a los 30 días; al cambiar la contraseña de startup el servidor vacía todas las sesiones antes de escuchar. No hay identidad humana vinculada a un token. Tanto el archivo server-side como el perfil local se escriben de forma atómica y con permisos privados.
- El comando plano `climier link <origin>` conserva el `project_id` existente en un checkout ya inicializado o clonado; solo genera un ID opaco nuevo si el checkout no tiene uno. Escribe la URL del server y el ID en `.climier.json`. Clones del mismo repo comparten ID y DAG. `link` no crea ni reemplaza datos del servidor: solo `climier init` autenticado puede provisionar un proyecto ausente; otras rutas solo abren proyectos ya existentes.
- Los comandos built-in operan en el estado server-side existente (state, log, ledger y lock por proyecto). El cliente no mantiene una copia editable ni hace fallback local. Desconexión, password incorrecta, credencial ausente o token inválido producen un error explícito.
- El bearer autoriza **todos** los project IDs de esa instancia. La autenticación identifica el servidor, no a la persona. `--as` continúa siendo texto de auditoría declarado por el cliente, no una identidad verificada. Cualquier persona con la contraseña puede obtener el bearer con acceso total y cualquier poseedor del bearer puede acceder a todos los DAGs y declarar cualquier `--as`.
- La protección de login bloquea 5 fallos consecutivos desde una dirección de red durante 15 minutos; un login correcto limpia el contador. El servidor usa la dirección del socket (no confía en `X-Forwarded-For` sin configuración explícita). HTTPS es obligatorio fuera de loopback.
- Se corta el mecanismo anterior de configuración remota (tokens manuales, `CLIMIER_TOKEN`, lista estática de credentials/projects y transferencias `push`/`pull`). No se mantiene compatibilidad ni migración automática desde remote v1. La configuración v1 falla con error que pide volver a linkear; no se leen sus secretos y no hay fallback local. Los datos previos quedan intactos en su storage anterior, fuera del servicio nuevo.
- El primer target alojable es una instancia del server con storage durable en un único host. No promete HA o escalado horizontal. Se conservan el runtime stdlib-only, el kernel, el ledger/fence y el recovery por proyecto; backup y restore del `stateHome` son responsabilidad del operador.

Flujo de uso propuesto:

```sh
# Una vez en cada equipo (TTY interactivo)
climier login --server https://climier.example.com

# Una vez por checkout nuevo; ID persistido al versionar el archivo del proyecto
climier link https://climier.example.com
climier init

# Uso normal, igual que en local
climier status
climier add-task ...
```

`climier link` es idempotente para un checkout que ya tiene server/project ID; no inventa un DAG distinto al clonar. El token permanece en el home del usuario y nunca se commitea.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Una contraseña general de la instancia → bearer de login con alcance global (recomendada) | UX mínima; un login por equipo; cada token sirve para todos los proyectos; sin gestión de cuentas o ACL | Compartir password concede acceso total; los tokens no identifican personas ni limitan proyectos; `--as` es autodeclarado. Aceptable para el objetivo personal/operador confiable. |
| Tokens estáticos de configuración compartidos por checkout | Implementación parecida al remote actual | Persiste la fricción de variables/configuración manual y no da un flujo de login. Rechazada. |
| Cuentas, organizaciones, roles, OIDC y scopes por proyecto | Aislamiento multiusuario y cloud SaaS | Exceso de alcance para el objetivo actual, exige control-plane y ciclos de vida de cuentas. Fuera de alcance. |
| Estado en DB compartida y server horizontal desde el inicio | Facilita HA/escalado | Cambia el contrato transaccional/ledger y añade infraestructura; no se necesita para alojar la instancia propia inicial. Fuera de alcance. |

## Alcance

- Dentro:
  - `climier login` / `logout`: prompt TTY seguro, password no admitido en argv/env, bearer guardado por server origin en perfil privado del usuario y reutilizado en requests.
  - Auth global del server; cada login emite un bearer sin identidad y con acceso a todos los proyectos. Cambiar password invalida todos los bearers.
  - `climier link`: conservar ID en un clone/checkout ya inicializado, generar uno solo cuando falta, y persistir URL+ID no secretos en `.climier.json`.
  - Provisionamiento dinámico y seguro del storage únicamente mediante `init` autenticado; paths hash-safe y confinados, reads/writes requieren estado ya existente.
  - Retirar el contrato remoto v1 por token/env y `push`/`pull`, pruebas y docs; error claro ante config antigua, sin fallback local ni migración.
  - Mantener local mode, operaciones core, atomicidad state+log y ledger/fence.
- Fuera:
  - Cuentas, contraseña por usuario, organizations/teams, roles, memberships, invitaciones, ACL por proyecto, OIDC, billing y UI de administración.
  - Identidad individual garantizada en el log; el actor `--as` sigue siendo etiqueta de auditoría.
  - Login no interactivo inicial (`--password`, env o stdin); importar datos/configuración remote v1 o compatibilidad con sus tokens/transferencias.
  - Cache offline, sincronización automática, multi-instancia, HA y storage compartido.
  - Eliminar el backend local.

## Riesgos y preguntas para ADR

- **Secreto global:** una filtración da acceso a todos los DAGs del server. Exigir HTTPS por defecto; password de alta entropía; no aceptar credenciales en URL/argv/log; comparación constant-time; bloquear 5 fallos consecutivos por dirección socket durante 15 minutos y probarlo; documentar que compartir password/token comparte control total.
- **Sesiones sin identidad:** el archivo privado del servidor conserva hashes y expiraciones de tokens, no los bearers. Debe tener permisos restrictivos y escritura atómica. Cambiar el password de startup vacía las sesiones; los bearer expiran en 30 días. Logout borra la copia local, pero no revoca el hash hasta expiración o rotación general.
- **Almacenamiento local del token:** definir ubicación privada, permisos y comportamiento de TTY/plataformas; no agregar dependencia al runtime CLI. Falla de escritura debe impedir decir que `login` terminó correctamente.
- **Clone/link:** un checkout con ID remoto ya existente preserva server/project; `link` solo genera si falta. Config remote v1 no se interpreta como nuevo contrato ni se sobrescribe silenciosamente; el error explica cómo relinkear y que eso no migra el DAG anterior.
- **Provisioning:** autenticar antes de crear/abrir storage; `init` es el único camino create-if-absent. El ID debe ser validado y traducido a ruta hash-safe bajo `dataRoot`.
- **No fallback:** backend remoto con credenciales ausentes/viejas/inválidas nunca debe leer/escribir state local; cubrir reads, writes, init, batch y error de protocolo. Un proyecto inexistente no se crea implícitamente en reads/writes.
- **Límite de alojamiento:** instancia con volumen durable es hostable pero no HA. Backup/restore debe incluir state y revision-ledger juntos; locks stale requieren recovery manual verificado según contrato actual.
- **Corte v1:** el cliente nuevo rechaza metadata remota antigua y sus variables con error accionable; no manda esos secretos, no auto-migra, no borra datos y no cae a local.

## ADRs derivados (se completa al aprobar)

- [ ] ADR: password general, bearers sin identidad, expiración/rotación y login/logout CLI.
- [ ] ADR: metadata de proyecto, semántica idempotente de `climier link` y provisioning confinado.
- [ ] ADR: corte de contrato remoto v1 (sin compatibilidad), routing y superficies retiradas.
- [ ] ADR: runbook y pruebas de la instancia single-host con almacenamiento durable.
