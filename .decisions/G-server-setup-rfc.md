# RFC: setup y verificacion del server remoto desde el CLI

- Gate: `G-server-setup-rfc` · Iniciativa: `server-setup` · Estado: en review
- Autor: orchestrator · Fecha: 2026-10-09

## Problema

Configurar el server remoto es ejecutar un runbook, no invocar una interfaz. La
unica superficie del server es `climier-server <private-config.json>`
(`bin/climier-server.ts`), sin `--help` ni `--check`. Para arrancar hay que
escribir a mano un `server.json` con forma exacta y claves exactas
(`src/server/runtime-config.ts`: solo `listen{host,port}`, `dataRoot`,
`stateHome`, `uiRoot`), con rutas absolutas, archivo regular **no** symlink y
permisos POSIX `0600` (`info.mode & 0o077 !== 0` -> `INVALID_SERVER_CONFIG`);
inyectar un secreto de alta entropia por entorno (cualquier valor no vacio pasa;
`SERVER_PASSWORD_REQUIRED` solo si falta, `src/server/auth/server-auth-store.ts`)
y componer un unit de servicio que ningun comando provee (el runbook solo muestra
un snippet). La verificacion hoy vive en el arranque: el operador descubre una
config invalida al bindear, leyendo un error de proceso.

Esto bloquea a dos consumidores a la vez. Un humano debe leer y transcribir
prosa. Un agente no puede ejecutar prosa: no inventa un secreto de entropia, no
fija permisos, no compone un unit, y no tiene TTY para un prompt. La
configuracion no tiene forma de comando ni salida legible por maquina, asi que
no es automatizable.

## Propuesta

Un nucleo no interactivo que materializa y verifica la configuracion, con una
capa humana fina encima. La regla rectora: **la logica vive en un nucleo por
flags con salida JSON; el wizard solo recolecta respuestas y delega**. El mismo
nucleo sirve a agentes, scripts y el humano.

1. **Verificacion compartida, sin bindear** - `src/server/preflight.ts` valida un
   config y su entorno y devuelve checks estructurados
   `{ id, status, detail, fix }`. Por defecto **no abre ningun socket**: valida
   forma, claves, permisos, rutas y secreto. Una sonda de puerto opcional vive
   aparte (`--probe-bind`): intenta un listen de vida corta y lo cierra; sus
   fallos son warnings salvo `--strict`. Tres consumidores:
   `climier-server --check <config>` (CI y agentes), `climier server doctor`
   (CLI) y el propio `server init` antes de escribir.
2. **Generador de artefactos** - `climier server init --root <dir>` crea
   `server.json` (0600), `<root>/server.env` (0600) con
   `CLIMIER_SERVER_PASSWORD=<crypto.randomBytes(32).base64url>` y el unit de
   servicio. **Nunca imprime el secreto** salvo `--print-secret` explicito. El
   JSON de salida incluye las rutas creadas y la secuencia de proximos comandos
   (arranque del servicio + `link`/`login`/`init` del cliente).
   - **Idempotencia**: re-ejecutar con los mismos flags sobre artefactos
     completos es no-op con `changed: false`. Si falta un artefacto, se crea el
     faltante y los demas se conservan (`changed: true`, `created: [...]`). Si un
     artefacto existe pero no coincide con los flags pedidos, falla con
     `SERVER_CONFIG_EXISTS` y no escribe nada; `--force` reescribe config y unit
     **conservando** el secreto. `--rotate-password` es la unica via que regenera
     el secreto (invalida todas las sesiones, ADR-043) y no requiere `--force`.
     Cada archivo se escribe con temp + chmod + rename, asi que una ejecucion
     interrumpida deja el archivo previo o ninguno, nunca uno mezclado.
   - **`--dry-run`** calcula y reporta
     `actions: [{ path, action: create|none|conflict }]` sin escribir ni crear
     directorios; sale 0 salvo input invalido.
   - El secreto llega al cliente `login` por acceso manual al archivo privado del
     host; no hay transporte automatico ni aparece en stdout. Rotar exige
     re-login en cada cliente.
3. **Doctor** - `climier server doctor` corre los mismos checks y reporta en JSON,
   para que un agente itere hasta `ok: true`. Acepta `--config` y `--env-file`;
   sin `--env-file` usa `<root>/server.env`, justo el archivo que el unit entrega
   por `EnvironmentFile=`, de modo que valida el mismo secreto que vera el
   servicio. El archivo se parsea como `KEY=VALUE` estricto, nunca ejecutando
   shell.
4. **Wizard humano** - `climier server setup` pregunta con defaults y llama al
   mismo `init`. Sin TTY **no se cuelga**: falla con `CLI_USAGE_ERROR` y enumera
   los flags exactos a pasar. Sus defaults y flags son exactamente los de `init`.
5. **Supervision** - `init` genera un unit systemd que usa
   `EnvironmentFile=<root>/server.env`; `--unit none` deja solo los artefactos
   para contenedores y ejecucion en foreground. La identidad del servicio es del
   operador: `--service-user <user>` agrega `User=` al unit; por defecto no se
   agrega y el unit no queda como root sin decision explicita. `init` crea
   `dataRoot`/`stateHome` con la identidad que lo invoca y, si `--service-user`
   difiere, **reporta** los `chown`/`chmod` necesarios en lugar de correrlos.
6. **Namespace local, independiente del backend** - `server` es un namespace
   reservado con subcomandos `init|doctor|setup` parseados en un unico adaptador.
   Son operaciones del host local, no del DAG: no requieren `--as`, no leen ni
   escriben estado de proyecto y **no pasan por la seleccion de backend**. En un
   checkout enlazado a un servidor remoto hoy caerian en
   `REMOTE_UNSUPPORTED_OPERATION` (`ensureRemoteCommandSupported`); el namespace
   `server` se rutea localmente antes de esa seleccion y se prueba con un
   proyecto con backend remoto.

`server` pasa a ser un namespace reservado. No cambia el contrato `/v1`, no
cambia el modelo de auth (ADR-043), no agrega endpoint de health y no toca el
listener sin politica de red (ADR-051).

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| A. Solo mejorar el runbook | Cero codigo; nada que romper | Sigue siendo prosa; no verificable ni automatizable; el agente la ignora. No cumple "un comando/documento" |
| B. Nucleo no interactivo + preflight compartido + wizard fino **(recomendada)** | Un solo camino de verdad; agent-friendly por construccion; verificable y testeable sin TTY; secreto por defecto fuera de stdout | Mas piezas que un script; hay que definir contrato de errores y de artefactos |
| C. TUI interactiva de configuracion | Atractiva para el humano; descubre opciones | Un agente no puede manejarla y se cuelga esperando input; exige framework o raw-mode en `src/`; el valor real de una TUI es **ops en vivo**, no config de una vez; alto costo para una tarea de baja frecuencia |
| D. Wizard interactivo unico, sin nucleo no interactivo | Un solo comando humano; poco codigo | Bloquea a agentes y CI; no testeable sin TTY; obliga a duplicar luego el nucleo |

## Alcance

- **Dentro**: `src/server/preflight.ts`, `--probe-bind` y `climier-server --check`;
  los subcomandos `server init`, `server doctor` y `server setup` bajo un unico
  namespace local; generacion de `server.json`, archivo de entorno con secreto y
  unit systemd; `server` como namespace reservado y su entrada en el help; un
  unico camino documentado (`server init` -> arranque -> `link`/`login`/`init`);
  tests de preflight, artefactos y adaptadores, con camino feliz, fallo de config,
  idempotencia/`--dry-run`, ausencia de secreto en stdout, `setup` con y sin TTY,
  y un proyecto con backend remoto.
- **Fuera**: contrato `/v1`, modelo de auth (ADR-043), politica de listener
  (ADR-051), endpoint de health, distribucion/binarios e instalacion
  (`T-launch-install`), cualquier deploy remoto, TUI, panel web de ops, imagenes
  de contenedor y launchd/macOS.

## Riesgos y open questions

- **Fuga del secreto** por stdout/stderr/logs -> el default nunca lo imprime;
  `--print-secret` es explicito y se documenta como inseguro.
- **Rotacion accidental** al re-ejecutar `init` -> cerrado por el contrato de
  idempotencia (`SERVER_CONFIG_EXISTS`, `--force` conserva el secreto,
  `--rotate-password` explicito).
- **Sonda de bind**: preflight no bindea; `--probe-bind` es opt-in, de vida corta
  y no bloqueante salvo `--strict`, para no confundir TIME_WAIT o un proceso
  ajeno con una config invalida.
- **systemd no es universal** -> `--unit none` y foreground para contenedores;
  systemd es el default documentado en Linux. launchd queda fuera.
- **Config con claves futuras** -> preflight conserva el rechazo de claves
  desconocidas de hoy; no relajarlo.
- **Generar en otra maquina**: el flujo soportado es generar en el host de
  destino. `--allow-missing-paths` permite generar fuera y degrada la existencia
  de `dataRoot`/`stateHome`/`uiRoot` a warning; el doc indica copiar y fijar
  owner/permisos en el host.
- **Servicio como root** -> `User=` solo con `--service-user`; sin el, el unit
  queda en la identidad del invocador y el resultado advierte si es root.
- **Riesgo residual**: `doctor` valida el archivo de entorno, no que systemd ya
  lo este entregando; no detecta drift de la unidad instalada. Se reporta como
  limite documentado, no como fallo.

Quedan fuera de este RFC y se difieren: imagen de contenedor, launchd, y
cualquier panel de ops en la web UI.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-057: comando `server init` y artefactos generados (config, secreto,
  unit) -> `.adrs/057-server-init-artifacts.md`
- [ ] ADR-058: contrato de verificacion pre-bind compartido (preflight,
  `--check`, `server doctor`) -> `.adrs/058-server-preflight-contract.md`
- [ ] ADR-059: supervision y propiedad de directorios del servicio ->
  `.adrs/059-server-service-supervision.md`
