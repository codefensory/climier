# RFC: experiencia remota de Climier lista para servicio alojado

- Gate: `G-remote-cloud-service-rfc` · Iniciativa: `remote-cloud-service` · Estado: en review
- Autor: orchestrator · Fecha: 2026-09-30

## Problema

El remote actual exige configurar `backend.url` y `project_id` por checkout, además de proporcionar `CLIMIER_TOKEN` y `CLIMIER_REMOTE_ORIGIN` fuera del repo. En el servidor, los proyectos permitidos y los tokens están definidos en un archivo estático; no hay identidad de usuario, membresía de organización ni gestión de proyectos como producto. El estado remoto ya es autoritativo y usa el kernel de Climier, pero la experiencia y el plano de control siguen siendo de operación manual para una instancia en un host.

El usuario aprobó reemplazar esta experiencia, sin compatibilidad con el setup remoto anterior, y conservar el backend local. El objetivo es que una persona se autentique una vez, vincule su checkout a un proyecto y ejecute los comandos CLI contra un DAG compartido. Los secretos y preferencias viven en el perfil local; el DAG y los permisos del proyecto viven en el servicio. La primera topología debe poder alojarse sobre almacenamiento durable, pero no debe presentarse como alta disponibilidad ni como escalado horizontal.

## Propuesta recomendada

- Autenticar usuarios mediante un flujo estándar de device authorization/OIDC: `climier login` inicia la autorización en el navegador y guarda una sesión local administrada por Climier. El servicio alojado usa un issuer operado para Climier; una instalación propia configura su issuer. No implementar autenticación/passwords ni OAuth/OIDC propio.
- Separar identidad, sesión, autorización, catálogo de proyectos y apertura del DAG. El servicio resuelve en cada request la identidad → membresía/rol → proyecto; la referencia del checkout no concede acceso. El API existente y el kernel server-side siguen ejecutando las operaciones.
- Guardar en `.climier.json` únicamente el origen no secreto del servicio/perfil y el `project_id` opaco. La sesión se guarda en el perfil privado del usuario, nunca en el checkout; priorizar keychain del sistema y definir una opción portable explícita si no está disponible.
- Dar un camino inicial concreto: el operador invita o aprovisiona al primer usuario propietario; ese owner crea una organización/proyecto y puede invitar miembros. La creación/linking muestra y confirma servidor, organización y proyecto. Sin membresía o conexión, la CLI falla explícitamente; no muestra un DAG vacío ni cae a local.
- Mantener el DAG y su ledger en el storage durable por proyecto existente, con un solo servicio writer por `stateHome`. La gestión de cuentas, organizaciones, membresías y catálogo necesita un control-plane durable transaccional separado. Como el runtime raíz es stdlib-only, el ADR debe evaluar store transaccional de filesystem single-instance vs introducir una dependencia/servicio externo. Elegir archivos hoy no implica que el futuro cambio a storage compartido sea transparente: sería una migración que debe conservar atomicidad, lock, ledger/fence y recovery.
- No importar automáticamente datos/configuración de remote v1 ni mantener su protocolo, tokens estáticos o `push`/`pull`. El nuevo servicio empieza con proyectos nuevos. El CLI nuevo rechaza con error accionable una configuración v1; no manda credenciales ni usa backend local como fallback. Los datos v1 permanecen donde estén hasta que el operador los respalde o elimine; el producto nuevo no ofrece migración. El backend local no cambia.

Flujo de usuario propuesto:

```text
climier login [--server <perfil>]
climier project create <nombre>   # si el usuario tiene permiso
climier project link              # en un checkout existente
climier status
```

La sintaxis final de `create`/`link`, la referencia exacta del servidor en el repo y el manejo de sesión quedan para ADR, pero el target remoto siempre se identifica sin ambigüedad como servidor/organización/proyecto.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener bearer tokens estáticos, escondiéndolos tras `login` | Cambio corto; conserva el servidor actual | Mantiene gestión manual; no crea identidad ni membresías; login sería solo una pantalla sobre el modelo viejo. Rechazada. |
| Identidad/passwords primera parte de Climier | UX propia | Obliga a construir y operar registro, recuperación, verificación, protección contra abuso y credenciales. Mayor riesgo; no recomendada. |
| Device authorization/OIDC (recomendada) | Login estándar por navegador; CLI no recibe password; soporta issuer gestionado o configurado por self-hosted | Requiere configurar un issuer y fijar expiración, refresh y revocación. No se implementa un protocolo parcial propio. |
| Access/refresh token en archivo privado local | Portable y stdlib-only | Permisos `0600` reducen lectura por otros usuarios, pero no cifran el token. Preferir keychain; definir fallback explícito. |
| Archivos por proyecto en volumen durable, instancia única (recomendada inicialmente para DAG) | Reutiliza kernel, ledger, recovery y storage; stdlib-only; se puede alojar en VM/container | Single point of availability; no despliegue horizontal ni failover automático. |
| Base/servicio transaccional compartido desde el primer release | Prepara HA y control-plane multi-instancia | Requiere dependencia/servicio y migrar contratos de commit/recovery; contradice potencialmente el límite stdlib-only. Decidirlo explícitamente. |

## Alcance

- Dentro:
  - UX de sesión CLI (`login`/`logout`) y configuración de servidores/perfiles.
  - Autenticación de usuarios mediante protocolo estándar y autorización por membresía/proyecto.
  - Crear/vincular proyectos por el servicio; la referencia en el repo no es un secreto ni concede acceso.
  - DAG remoto autoritativo, sin espejo/cache offline ni fallback local.
  - Retirar el contrato remoto anterior de credenciales estáticas, `CLIMIER_TOKEN`, `CLIMIER_REMOTE_ORIGIN`, transferencias remotas `push`/`pull`, pruebas y documentación. No ofrecer compatibilidad ni migración automática desde el remote actual.
  - Mantener intacto el backend local, salvo seams compartidos necesarios y cubiertos por tests.
  - Servicio alojable sobre storage durable single-instance; documentar backup/restore coordinado del control-plane, state y ledger, y el límite de disponibilidad.
- Fuera salvo decisión posterior:
  - Billing, cuotas y panel web completo.
  - Alta pública abierta; primer owner por invitación/bootstrap del operador.
  - HA multi-región, escalado horizontal, caché/offline y sincronización de DAGs.
  - Import/export de datos v1; los datos viejos no se modifican ni borran desde el producto nuevo.
  - Eliminar el backend local.

## Riesgos y preguntas para el ADR

- **Issuer y sesión:** elegir issuer inicial, formato de sesión, expiración, refresh/revocación y keychain/fallback local; el ADR debe evitar credenciales persistentes en texto claro por defecto y nunca escribirlas a `.climier.json` o logs.
- **Control-plane durable:** usuarios/organizaciones/membresías/proyectos requieren fuente de verdad y transacciones concurrentes. Comparar store filesystem single-writer stdlib-only con servicio externo/DB y señalar explícitamente garantías y migración futura.
- **Aislamiento:** probar acceso entre organizaciones, proyecto no permitido y revocación de una membresía frente a requests nuevos.
- **Bootstrap:** especificar cómo el operador crea/invita al primer owner, cómo este crea la primera organización/proyecto e invita al equipo, y cómo el servicio alojado configura ese flujo sin alta anónima.
- **Referencia del checkout:** especificar cómo un clone en otra máquina descubre el servidor y el proyecto sin llevar credenciales, y qué perfil local se necesita para servidores self-hosted.
- **Fallos:** auth inválida, membresía revocada, proyecto no vinculado o red caída deben producir error inequívoco con servidor/organización/proyecto y fallar cerrado, nunca devolver vacío ni usar local.
- **Corte remoto v1:** config v1 detectada debe retornar error de configuración/protocolo antes de enviar bearer; el nuevo CLI no abre ni importa storage remoto v1, no instala el legacy backend y no ejecuta transferencias v1. Los datos originales quedan intactos fuera del servicio nuevo.
- **Storage futuro:** sustituir el store single-instance por uno compartido no es un cambio de adapter trivial; requerirá ADR/migración que conserve state+log atómicos, revisión monotónica, fencing, lock/recovery y aislamiento por tenant.

## ADRs derivados (se completa al aprobar)

- [ ] ADR: autenticación estándar de usuarios y ciclo de vida de sesión CLI.
- [ ] ADR: organizaciones, membresías, bootstrap, autorización y provisioning de proyectos.
- [ ] ADR: store transaccional del control-plane, storage del DAG y topología del primer servicio alojado.
- [ ] ADR: nuevo contrato CLI/config y corte del remote v1 sin compatibilidad.
