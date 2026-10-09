# ADR-058: Contrato de verificacion pre-bind compartido

- Gate: `G-adr058-server-preflight` · Deriva de: `G-server-setup-rfc` · Estado: borrador
- Fecha: 2026-10-09

## Contexto

La validacion de la configuracion del server existe pero solo se ejerce como
efecto del arranque: `loadServerRuntimeConfig` (`src/server/runtime-config.ts`)
rechaza forma, rutas y permisos, y `createServerAuthStore` exige
`CLIMIER_SERVER_PASSWORD` (`SERVER_PASSWORD_REQUIRED`). No hay forma de correr
esos chequeos sin arrancar y bindear, ni salida legible por maquina. `doctor` y
`climier-server --check` necesitan una unica implementacion que no duplique las
reglas de `runtime-config.ts`.

## Decision

### 1. Modulo unico `src/server/preflight.ts`

Exporta `checkServerConfig(options)` que devuelve
`{ ok, checks: [{ id, status: "pass"|"warn"|"fail", detail, fix }] }`.
**No abre sockets por defecto**: solo valida forma, claves, permisos, rutas y
secreto. Reutiliza `parseServerRuntimeConfig` para la forma y no reimplementa
sus reglas.

Checks:

- config existe, es archivo regular, no symlink, `0600` en POSIX, JSON valido.
- solo claves conocidas; claves legacy (`credentials`, `projectIds`) ->
  `SERVER_LEGACY_CONFIG` con `fix`.
- `dataRoot`/`stateHome` absolutas; existencia y escritura (o creacion posible).
- `uiRoot` con `index.html`: `warn` si falta (el server responde 503 en `/` y la
  API sigue).
- secreto presente y no vacio; `warn` si su entropia es baja.
- `CLIMIER_SERVER_MAX_BODY_BYTES` entero dentro de rango si esta seteado.

### 2. Fuente del entorno

- `--env-file <path>`: archivo `KEY=VALUE` estricto, sin ejecutar shell; solo se
  leen `CLIMIER_SERVER_PASSWORD` y `CLIMIER_SERVER_MAX_BODY_BYTES`. Claves
  desconocidas o lineas malformadas -> `fail`.
- Sin `--env-file`, se lee `process.env`.
- `server doctor` sin `--env-file` usa `<root>/server.env`, que es el mismo
  archivo que el unit entrega por `EnvironmentFile=` (ADR-059), para validar el
  secreto que el servicio vera y no uno distinto.

### 3. Sonda de bind opcional

`--probe-bind` intenta un listen de vida corta en `listen.host:listen.port` y lo
cierra. Sus fallos (`EADDRINUSE`, `EACCES`) son `warn` salvo `--strict`, que los
vuelve `fail`. Por defecto la sonda **no** corre, para no confundir TIME_WAIT o un
proceso ajeno con una config invalida.

### 4. Superficies

- `climier-server --check <config> [--env-file P] [--probe-bind] [--strict]`:
  corre preflight, imprime JSON y sale 0/1. No debe preparar `stateHome`/
  `dataRoot`, no toma el service lock y no construye el auth store. Se resuelve
  antes de `startServerRuntime`.
- `climier server doctor [--config P] [--env-file P] [--probe-bind] [--strict]`:
  mismos checks bajo el namespace `server` (ADR-057). Salida JSON con `ok` y
  `checks`; exit 1 si algun check es `fail`.

### 5. Codigos de error

Se conserva `INVALID_SERVER_CONFIG` para forma. Se agregan `SERVER_LEGACY_CONFIG`,
`SERVER_SECRET_MISSING`, `SERVER_UI_ROOT_MISSING` (warning) y
`SERVER_PORT_UNAVAILABLE` (sonda). `doctor` sale 1 con `ok: false` cuando hay
`fail`; los `warn` no cambian el exit code salvo `--strict`.

Limite explicito: `doctor` valida el archivo de entorno, no que systemd ya lo
este entregando; no detecta drift de la unidad instalada.

## Consecuencias

- A favor: una sola fuente de verdad de validacion, reutilizada por el arranque,
  `--check`, `doctor` e `init`; verificable por agentes sin bindear ni tocar
  estado; los errores de config se descubren antes del bind.
- En contra / deuda: `--check` y `startServerRuntime` comparten reglas via
  `runtime-config.ts`, asi que un cambio de forma debe mantener ambos en verde.
- En contra / deuda: los permisos POSIX no se ejercen en Windows; los checks de
  modo se saltan alli y se reportan como tales.
- Sin cambios: contrato `/v1`, auth y listener.

## Plan de implementacion

1. `src/server/preflight.ts` con los checks y el parser de env file, mas tests con
   configs literales (valido, claves legacy, permisos, secreto ausente, uiRoot
   ausente, max body invalido).
2. `climier-server --check` en `bin/climier-server.ts`, resolviendo antes de
   `startServerRuntime`.
3. `server doctor` bajo el router de ADR-057, con `--env-file` por defecto
   `<root>/server.env`.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — el modulo es la base; `--check` y `doctor` son dos
  adaptadores delgados. Ver tasks de `server-setup`.

## Verificacion

- `climier-server --check <config-valido>` sale 0 y no crea `dataRoot`/
  `stateHome` ni toma el lock.
- Falta de `CLIMIER_SERVER_PASSWORD` produce `SERVER_SECRET_MISSING` y sale 1
  antes de cualquier bind; claves legacy producen `SERVER_LEGACY_CONFIG`.
- Permisos con grupo/otros distintos de cero y symlink fallan con
  `INVALID_SERVER_CONFIG`.
- `uiRoot` sin `index.html` es `warn` (exit 0); con `--strict` es `fail`.
- `--probe-bind` sobre un puerto ocupado es `warn`; con `--strict`, `fail`.
- `doctor` sin `--env-file` lee `<root>/server.env`; un `<root>/server.env` con
  secreto valido pasa aunque `process.env` no lo tenga.
