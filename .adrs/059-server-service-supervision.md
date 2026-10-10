# ADR-059: Supervision y propiedad del servicio

- Gate: `G-adr059-server-supervision` · Deriva de: `G-server-setup-rfc` · Estado: borrador
- Fecha: 2026-10-09

## Contexto

`docs/remote-server.md` muestra un snippet de unit systemd pero ningun comando lo
genera. El runtime (`startServerRuntime`) crea `stateHome` y `dataRoot` con
`0700` e identidad del proceso, escribe `stateHome/remote-auth.json` con `0700`/
`0600`, y toma `stateHome/.server.lock` durante toda la vida del servicio
(ADR-043). Falta decidir que genera `server init`, con que identidad corre el
servicio y quien posee los directorios.

## Decision

### 1. Unit systemd por defecto, opt-out

- `--unit systemd` (default): `server init` escribe `<root>/<service-name>.service`
  (default `climier-server.service`).
- `--unit none`: no escribe unit; solo `server.json` y `server.env`, para
  contenedores y ejecucion en foreground con `climier-server <config>`.

### 2. Contenido del unit

- `ExecStart=<root>/climier-server <root>/server.json`.
- `EnvironmentFile=<root>/server.env`.
- `Restart=on-failure`.
- **Sin hardening** (enmienda 2026-10-10): el generador no emite
  `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`, `ProtectHome` ni
  `ReadWritePaths`. Endurecer el servicio y elegir donde vive es del operador;
  ver la enmienda al final.
- `User=`/`Group=` **solo** cuando se pasa `--service-user <user>`. Sin el flag no
  se agrega `User=`, de modo que el unit no corre como root por decision implicita
  de `init`.

### 3. Propiedad de directorios y archivos

- `server.json` y `server.env`: `0600`, propiedad del invocante.
- `dataRoot` y `stateHome`: creados con la identidad del invocante y modo `0700`
  si no existen; el runtime los reafirma a `0700` al arrancar.
- El binario `climier-server` no lo gestiona `init`; el unit asume que existe en
  `<root>/climier-server` y `doctor` reporta si falta.
- Si `--service-user` difiere del invocante, `init` **reporta** en su salida los
  `chown`/`chmod` necesarios; no ejecuta privilegios ni `sudo`.
- Si el invocante es `root`, la salida incluye una advertencia explicita.

### 4. Limites

- `init` no instala, habilita ni inicia el unit: emite los comandos siguientes
  (`systemctl daemon-reload`, `enable --now`, etc.) en `next`.
- Fuera de alcance: launchd/macOS, imagen de contenedor y cualquier gestion de
  usuarios del sistema.

Sin dependencias de runtime nuevas (renderizado por template de strings).

## Consecuencias

- A favor: el servicio queda supervisado y endurecido sin que el operador escriba
  el unit; la identidad del servicio es una decision explicita.
- A favor: `--unit none` cubre contenedores y foreground sin imponer systemd.
- En contra / deuda: el hardening con `ProtectSystem=strict` exige
  `ReadWritePaths` correcto; si `dataRoot`/`stateHome` viven fuera de la ruta
  asumida, el servicio falla al escribir. El doc y `doctor` deben advertirlo.
- En contra / deuda: el unit generado referencia `<root>/climier-server`, pero
  `init` no lo instala; un host sin binario falla al arrancar.
- Sin cambios: lock, auth store, contrato `/v1`.

## Plan de implementacion

1. Renderer `src/server/systemd-unit.ts` — template puro, parametrizado por
   rutas, nombre de unidad y `--service-user`, con tests de contenido y de la
   ausencia de `User=` por defecto.
2. Propiedad y advertencias en `src/server/setup-artifacts.ts` (ADR-057) — crear
   `dataRoot`/`stateHome` `0700`, reportar `chown`/`chmod` cuando
   `--service-user` difiere, advertir en root.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — el renderer es parte de la task de artefactos; ver
  tasks de `server-setup`.

## Verificacion

- `server init` sin `--service-user` genera un unit sin `User=` y con
  `EnvironmentFile=<root>/server.env`; con `--service-user climier` agrega
  `User=climier` y reporta los `chown`/`chmod` pendientes.
- `--unit none` no escribe unit y la salida JSON lo refleja.
- `dataRoot`/`stateHome` inexistentes se crean `0700`; existentes no se alteran.
- El unit no emite hardening; `dataRoot` y `stateHome` conservan la validacion de
  ruta absoluta aunque el unit ya no los use.
- `doctor` reporta `fail` si el binario o el unit esperado no existen.

## Enmienda (2026-10-10)

La decision 2 cambio: el unit generado **no** endurece el servicio. El hardening
se revirtio porque imponia politica de seguridad y de ubicacion a nombre de
climier: con `ProtectHome=true` el unit solo arrancaba con la raiz fuera de
`/home` y `/root`, y `ProtectSystem=strict` obligaba a un `ReadWritePaths`
exacto, sin que nada lo advirtiera en codigo. Ahora el operador endurece con un
drop-in de systemd (`ProtectSystem`, `ProtectHome`, `ReadWritePaths` y el
ordering del listener), y `init` no opina sobre la ubicacion: no agrega checks
ni warnings por una raiz bajo `$HOME` o `/root`. El defecto, la evidencia
empirica y la decision estan en `T-server-unit-home-root-sandbox`.
