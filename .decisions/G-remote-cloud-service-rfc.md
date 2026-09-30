# RFC: remote simple para un servidor propio de Climier

- Gate: `G-remote-cloud-service-rfc` · Iniciativa: `remote-cloud-service` · Estado: en review
- Autor: orchestrator · Fecha: 2026-09-30

## Problema

El remote actual requiere que cada checkout tenga `backend.url` y `project_id`, mientras cada comando remoto depende de un bearer y un origin-binding configurados manualmente. El servidor además mantiene una lista estática de proyectos y tokens. Eso complica el objetivo inmediato: una persona levanta un servidor Climier en su máquina, lo usa desde varios checkouts y comparte una sola contraseña de acceso con quien confíe.

La decisión explícita del usuario es mantenerlo simple: **un servidor administrado por su operador, una contraseña general configurada al iniciar el servicio, un token para el cliente que inicia sesión, y acceso de ese token a todos los proyectos linkeados a ese servidor**. No se requieren cuentas, organizaciones, roles, membresías, invitaciones, billing ni alta pública. El backend local de Climier se conserva.

## Propuesta recomendada

- El operador entrega la contraseña general al proceso `climier-server` mediante un mecanismo privado de startup (preferiblemente entorno/secret manager, nunca argumento visible, repo ni log). El servicio rechaza arrancar si falta.
- `climier login --server <origin>` solicita la contraseña por entrada interactiva segura y la envía una vez por HTTPS. Si es válida, el server emite el bearer token que la CLI guarda fuera del repo, asociado al origin. Los comandos posteriores usan esa sesión. `climier logout` elimina la sesión local. El token autoriza **todos** los project IDs de esa instancia; no existe identidad individual ni ACL por proyecto.
- `climier project link` crea/selecciona el ID opaco del checkout y guarda en `.climier.json` solo la URL pública del server y el ID no secreto. `climier init` provisiona el DAG remoto. El server genera una ruta hash-safe bajo su `dataRoot` para cada ID válido autenticado; no hace falta mantener `projectIds` manualmente en el config del server.
- Los comandos built-in operan en el estado server-side existente (state, log, ledger y lock por proyecto). El cliente no mantiene una copia editable ni hace fallback local. Desconexión, contraseña incorrecta o token inválido producen un error explícito.
- Rotar la contraseña general invalida el acceso de toda la instalación; todos sus clientes vuelven a hacer login. La autenticación identifica el servidor, no a la persona. `--as` continúa siendo texto de auditoría declarado por el cliente, no una identidad verificada. Cualquier persona con la contraseña/token puede acceder a todos los proyectos y declarar cualquier `--as`.
- Se corta el mecanismo anterior de configuración remota (tokens manuales, `CLIMIER_TOKEN`, `CLIMIER_REMOTE_ORIGIN`, lista estática de credentials/projects y transferencias `push`/`pull`). No se mantiene compatibilidad ni migración automática desde remote v1. La configuración v1 falla con error de relink; no se leen sus secretos y no hay fallback local. Los datos previos quedan intactos en su storage anterior, fuera del servicio nuevo.
- El primer target alojable es una instancia del server con storage durable en un único host. No promete HA o escalado horizontal. Se conservan el runtime stdlib-only, el kernel, el ledger/fence y el recovery por proyecto; backup y restore del `stateHome` son responsabilidad del operador.

Flujo de uso propuesto:

```sh
# Una vez en cada equipo
climier login --server https://climier.example.com

# Una vez en cada checkout nuevo
climier project link --server https://climier.example.com
climier init

# Uso normal, igual que en local
climier status
climier add-task ...
```

`project link` escribe una referencia server/project reproducible al clonar el repo. La sesión/token permanece en el home del usuario y nunca se commitea. Los nombres de comandos y la persistencia/rotación del token se fijan en ADR, manteniendo este modelo sin cuentas ni scopes por proyecto.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Una contraseña general de la instancia → bearer global (recomendada) | UX mínima; un login por máquina; todos los proyectos de esa instalación; sin gestión de cuentas o ACL | Compartir credencial concede acceso total; no hay identidad individual ni revocación por persona/proyecto; `--as` es autodeclarado. Aceptable para el objetivo personal/operador confiable. |
| Tokens estáticos de configuración compartidos por checkout | Implementación parecida al remote actual | Persiste la fricción de variables/configuración manual y no da un flujo de login. Rechazada. |
| Cuentas, organizaciones, roles, OIDC y scopes por proyecto | Aislamiento multiusuario y cloud SaaS | Exceso de alcance para el objetivo actual, exige control-plane y ciclos de vida de cuentas. Fuera de alcance. |
| Estado en DB compartida y server horizontal desde el inicio | Facilita HA/escalado | Cambia el contrato transaccional/ledger y añade infraestructura; no se necesita para alojar la instancia propia inicial. Fuera de alcance. |

## Alcance

- Dentro:
  - `climier login` / `logout`: pedir la contraseña de la instancia de forma segura, recibir/guardar el token en perfil de usuario por server origin y usarlo en requests posteriores.
  - Configuración de la contraseña al iniciar el server y endpoint de login/token con verificación segura, rate limiting básico y transporte HTTPS fuera de loopback.
  - Credencial global para la instancia: una sesión/token tiene acceso a cualquier ID de proyecto de ese server; rotar la contraseña invalida sesiones existentes.
  - `climier project link`: crear o vincular un ID opaco y persistir URL+ID no secretos en `.climier.json`.
  - Provisionamiento dinámico y seguro del storage de proyectos sin allowlist estática; paths hash-safe y confinados.
  - Retirar el contrato remoto v1 por token/env y `push`/`pull`, pruebas y docs; error claro ante config antigua, sin fallback local ni migración.
  - Mantener local mode, operaciones core, atomicidad state+log y ledger/fence.
- Fuera:
  - Cuentas, contraseña por usuario, organizations/teams, roles, memberships, invitaciones, ACL por proyecto, OIDC, billing y UI de administración.
  - Identidad individual garantizada en el log; el actor `--as` sigue siendo etiqueta de auditoría.
  - Importar datos/configuración remote v1, compatibilidad con sus tokens o transferencias.
  - Cache offline, sincronización automática, multi-instancia, HA y storage compartido.
  - Eliminar el backend local.

## Riesgos y preguntas para ADR

- **Secreto global:** una filtración da acceso a todos los DAGs del server. Exigir HTTPS por defecto; contraseña de alta entropía; no aceptar credenciales en URL/argv/log; comparar con constant-time; limitar intentos de login; guardar tokens fuera del repo con permisos privados; documentar que compartir la contraseña comparte control total.
- **Token emitido:** definir formato, almacenamiento server-side vs firmado, persistencia después de reinicio, expiración y revocación global. Debe ser bearer aleatorio no derivable de la contraseña; rotar la contraseña debe invalidar los anteriores. No necesita identidad por usuario ni CRUD de sesiones.
- **Almacenamiento local del token:** definir ubicación privada y permisos (y manejo en plataformas soportadas); no agregar dependencia al runtime CLI. El logout debe borrar la sesión asociada solo al server indicado.
- **Project link/provisioning:** definir si `link` crea un ID nuevo automáticamente o también acepta uno existente; validar tamaño/formato del ID y resolverlo a una ruta hash-safe bajo `dataRoot`; auth siempre antes de crear/abrir storage.
- **No fallback:** backend remoto configurado con credenciales ausentes, viejas o inválidas nunca debe leer/escribir state local; cubrir reads, writes, init, batch y error de protocolo.
- **Límite de alojamiento:** una instancia con volumen durable es hostable pero no HA. Backup/restore debe incluir state y revision-ledger juntos; locks stale requieren recovery manual verificado según contrato actual.
- **Corte v1:** el cliente nuevo no procesa `backend.type=remote` legacy ni sus variables. Error accionable que indique relink/login; no auto-migrar ni borrar los archivos antiguos.

## ADRs derivados (se completa al aprobar)

- [ ] ADR: contraseña de instancia, emisión/validación/rotación del token y sesión CLI local.
- [ ] ADR: metadata de proyecto, `project link` y provisioning dinámico confinado.
- [ ] ADR: corte de contrato remoto v1 (sin compatibilidad), routing y superficies retiradas.
- [ ] ADR: runbook y pruebas de la instancia single-host con almacenamiento durable.
