# ADR-057: Comando `server` y generacion de artefactos de setup

- Gate: `G-adr057-server-init` · Deriva de: `G-server-setup-rfc` · Estado: borrador
- Fecha: 2026-10-09

## Contexto

Hoy la unica superficie del server es `climier-server <private-config.json>`:
sin `--help`, sin `--check`, sin forma de generar la configuracion. El operador
escribe `server.json` a mano (forma y permisos estrictos en
`src/server/runtime-config.ts`), inventa un secreto, y compone un unit que nadie
provee. El RFC aprobado (`../.decisions/G-server-setup-rfc.md`) fija un nucleo no
interactivo agent-friendly mas una capa humana fina.

Restriccion descubierta en review: el dispatcher elige backend desde
`.climier.json` y rechaza con `REMOTE_UNSUPPORTED_OPERATION` cualquier comando
fuera de `REMOTE_SUPPORTED_COMMANDS`
(`src/cli/dispatch.ts: ensureRemoteCommandSupported`), antes de cargar el
comando. `server init` es una operacion del host local, no del DAG.

## Decision

### 1. Un namespace local reservado

- `server` se registra como namespace reservado (`RESERVED_NAMESPACES`), en
  `KNOWN_COMMANDS`/`COMMANDS` y en el help.
- Un unico adaptador `src/cli/commands/server.ts` enruta `positional[0]` a los
  subcomandos `init`, `doctor` y `setup`; cada subcomando vive en
  `src/cli/commands/server/<name>.ts`. Un subcomando desconocido falla con
  `CLI_USAGE_ERROR` y la lista valida.
- El namespace `server` **no** pasa por la seleccion de backend: se reconoce y
  se rutea antes de `ensureRemoteCommandSupported`, no crea backend client, no
  requiere `--as` y no lee ni escribe estado de proyecto. Funciona igual en un
  checkout con backend local o remoto.

### 2. `server init` genera los artefactos

`climier server init --root <dir>` escribe, con la identidad del invocante:

- `<root>/server.json` modo `0600`, con exactamente `listen{host,port}`,
  `dataRoot`, `stateHome` y `uiRoot` opcional; se valida con
  `parseServerRuntimeConfig` antes de escribir (no se duplican reglas de forma).
- `<root>/server.env` modo `0600` con
  `CLIMIER_SERVER_PASSWORD=<crypto.randomBytes(32).toString("base64url")>` (y
  opcionalmente `CLIMIER_SERVER_MAX_BODY_BYTES`).
- El unit de servicio segun ADR-059.

Flags: `--root`, `--host` (default `127.0.0.1`), `--port` (default `43127`),
`--data-root`, `--state-home`, `--ui-root`, `--service-user`, `--unit systemd|none`,
`--allow-missing-paths`, `--dry-run`, `--force`, `--rotate-password`,
`--print-secret`, `--yes`.

### 3. Secreto

- Se genera con `node:crypto`; nunca se imprime en stdout, stderr ni logs.
- `--print-secret` es la unica via que lo muestra y se documenta como insegura.
- El cliente `login` obtiene el secreto por acceso manual al archivo privado del
  host; no hay transporte automatico.

### 4. Idempotencia y `--dry-run`

- Artefactos completos y consistentes con los flags: no-op, `changed: false`.
- Artefacto faltante: se crea el faltante y se conservan los existentes
  (`changed: true`, `created: [...]`).
- Artefacto existente que no coincide con los flags: `SERVER_CONFIG_EXISTS`, sin
  escribir nada.
- `--force`: reescribe config y unit para que coincidan con los flags,
  **conservando** el secreto existente.
- `--rotate-password`: unica via que regenera el secreto; invalida las sesiones
  (ADR-043) y no requiere `--force`.
- Escritura por archivo con temp + `chmod` + `rename`; una ejecucion interrumpida
  deja el archivo previo o ninguno, nunca uno mezclado.
- `--dry-run` calcula y reporta `actions: [{ path, action: create|none|conflict }]`
  sin escribir ni crear directorios; sale 0 salvo input invalido.

### 5. Salida JSON

`{ ok, root, changed, created: [...], files: { config, env, unit }, listen,
secret: { written: true, printed: false }, actions?, next: [...] }`. `next`
incluye el arranque del servicio y la secuencia cliente `link`/`login`/`init`.

### 6. `server setup`

Wizard TTY que recolecta las mismas opciones con defaults y delega en `init`. Sin
TTY falla con `CLI_USAGE_ERROR` enumerando los flags exactos; nunca bloquea
esperando input. Reutiliza el patron de TTY de `src/cli/commands/login.ts`.

Sin dependencias de runtime nuevas (stdlib `node:crypto` y `node:fs`).

## Consecuencias

- A favor: el setup deja de ser un runbook; un agente puede generarlo y un humano
  puede guiarse; el secreto no aparece por defecto en ningun stream; reintentos
  seguros.
- A favor: `server` es local por diseno, asi que funciona aunque el checkout este
  enlazado a un servidor remoto.
- En contra / deuda: superficie CLI nueva que mantener y documentar.
- En contra / deuda: `init` no instala, habilita ni inicia el servicio; solo
  reporta los comandos siguientes. Instalar el unit queda en el operador.
- Sin cambios: contrato `/v1`, modelo de auth (ADR-043) y politica de listener
  (ADR-051).

## Plan de implementacion

1. Modulo de artefactos y unit — `src/server/setup-artifacts.ts`,
   `src/server/systemd-unit.ts` (ver ADR-059), con tests de contenido, modos,
   idempotencia y `--dry-run`.
2. Namespace y router `server` — `src/cli/commands/server.ts`,
   `reserved-namespaces.ts`, `dispatch.ts`, help, con prueba de ruteo local en
   checkout remoto.
3. Adaptador `server init` — `src/cli/commands/server/init.ts`.
4. Wizard `server setup` — `src/cli/commands/server/setup.ts`.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — el corte de tasks sigue las fronteras del router y
  los modulos; ver las tasks de la iniciativa `server-setup`.

## Verificacion

- `server init --root <tmp> --dry-run` no escribe nada y reporta `actions`;
  repetir sin `--dry-run` crea los tres artefactos con modos `0600`; repetir igual
  es `changed: false`; repetir con `--port` distinto falla con
  `SERVER_CONFIG_EXISTS`; `--force` reescribe config/unit sin cambiar el secreto;
  `--rotate-password` cambia solo el secreto.
- El secreto no aparece en stdout, stderr ni en el JSON salvo `--print-secret`.
- `climier server init` y `climier server doctor` funcionan en un checkout con
  `backend: { type: "remote" }` sin `REMOTE_UNSUPPORTED_OPERATION`.
- `server setup` sin TTY sale con `CLI_USAGE_ERROR` y la lista de flags; con TTY
  simulado produce el mismo resultado que `init` con los mismos valores.
