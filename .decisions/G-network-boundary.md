# RFC: Quitar de climier la política de boundary de red

- Gate: `G-network-boundary` · Iniciativa: `remote-cloud-service` · Estado: en review
- Autor: orchestrator · Fecha: 2026-10-06
- Supersede: `G-server-listen-optin` (descartado), ADR-028 (opt-in HTTP de
  cliente) y la cláusula "listener loopback-only" de ADR-043.

## Problema

Climier hoy intenta ser responsable de dos cosas que no le corresponden:
**dónde se hostea** el server y **cómo se consume**. Consecuencias medidas:

- `src/server/runtime-config.ts` exige loopback (ADR-043). El host de produccion
  `agento` no puede cumplirlo, asi que sobrevive con un parche out-of-tree
  (`deploy-base` `98c941b`, duplicado en la rama TS `144849d`) que **acopla el
  producto a Tailscale**: `isTailscaleIPv4`, `assignedToTailscale0` y
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP`. Tailscale es infraestructura del
  operador, no un concepto de climier.
- `src/application/backend-config.ts` y `src/storage/credential-profile.ts`
  rechazan un origin `http:` no-loopback salvo
  `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true` (ADR-028). Es un segundo gate,
  distinto, para una decision de riesgo que es del operador.

El resultado es friccion (dos flags para un caso), un parche de vendor sin
upstream, y una eleccion de exposicion de red que el tool no puede juzgar mejor
que quien despliega. Como mucho, climier puede **avisar**.

## Propuesta

Principio: **climier no valida ni rechaza el host de bind ni el transporte del
origin remoto**. Solo:

1. acepta lo que el operador configure;
2. emite un **warning estructurado y no bloqueante** cuando un origin remoto no
   usa HTTPS, en `login`, `link` e `init`;
3. permite silenciar warnings con un flag global `--no-warnings`.

Lo que **no** cambia (no es boundary de red, es higiene de credenciales):
password por TTY y nunca en argv/env/logs; bearer hasheado server-side; perfil
`0600` por origin; origin sin userinfo/query/hash; rate limit de login; lock de
servicio; sin fallback a estado local ante error remoto.

## Mapeo completo: qué se remueve y qué queda

| Superficie | Hoy | Después |
|---|---|---|
| `runtime-config.ts` `listen.host` | Solo loopback (`isLoopbackHost`) | `string` no vacío: `127.0.0.1`, `0.0.0.0`, `::`, IP de interfaz o hostname; climier no opina |
| `runtime-config.ts` Tailscale | `isTailscaleIPv4` + `assignedToTailscale0` + `networkInterfaces` | Eliminados |
| `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP` | Gate del bind | Eliminado (el bind ya no se gatea) |
| `parseServerRuntimeConfig(value, options)` | `options` inyectable solo para esa política | Sin `options` |
| `deploy-base` `98c941b` | Parche de vendor del deploy | Obsoleto |
| `parseRemoteBackend` (cliente) | Falla si `http:` no-loopback sin env | No falla; calcula `insecureRemoteHttp` para el warning |
| `normalizeOrigin` (perfil) | Rechaza `http:` no-loopback sin env | Acepta `http:`/`https:` sin credenciales |
| `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` | Gate del cliente | Eliminado |
| `init` remoto | `warnings` solo si el env estaba seteado | `warnings` si el origin no es HTTPS |
| `link` | Sin warnings | `warnings` si el origin no es HTTPS |
| `login` | Sin warnings | `warnings` si el origin no es HTTPS |
| Flag global | — | `--no-warnings` (suprime los warnings de red) |

## Contrato de los warnings

- Forma (reusa la que ya tiene `init`):
  `{ kind: "insecure-remote-http", severity: "warning", message: "<command>: <origin> no usa HTTPS; el password de login y el bearer viajan sin cifrar. Usá TLS o una red confiable." }`
- Se agrega como campo aditivo `warnings` al resultado de `login`
  (`{ session, warnings? }`), `link` (`{ project, warnings? }`) e `init`
  (`{ ok, seeded, file, warnings? }`).
- Se emite solo cuando el origin es `http:` y el host no es loopback (loopback
  HTTP es local y no cruza la red).
- `<origin>` es `new URL(backend.url).origin` (`scheme://host[:port]`, sin path
  ni credenciales), idéntico en `login`, `link` e `init`.
- `--no-warnings` es un flag global: se acepta antes o después del comando
  (allowlist global en `validateKnownFlags` + `BOOLEAN_FLAGS` + `HELP_TEXT`). No
  se incorpora `CLIMIER_NO_WARNINGS`; queda explícitamente fuera.

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| A. Dejar loopback-only + gate HTTPS (status quo) | Postura mas estricta | Mantiene el parche Tailscale, la friccion y la responsabilidad ajena a climier |
| B. Opt-in generico `CLIMIER_SERVER_ALLOW_REMOTE_HTTP` + gate cliente (`G-server-listen-optin`, descartada) | Un solo flag del server | Sigue siendo climier gateando el deployment; no quita la responsabilidad, la renombra |
| C. **Quitar la politica; solo warnings + `--no-warnings` (recomendada)** | climier deja de policiar red; sin vendor lock-in; una sola superficie de aviso | El operador puede exponer HTTP plano con password/bearer sin friccion; riesgo real si ignora el warning |
| D. Cero warnings, cero flags | Minima superficie | Pierde el unico valor defensivo razonable: avisar |

## Alcance

- **Dentro:**
  - `src/server/runtime-config.ts` (+ `runtime.ts` si hace falta): quitar la
    politica de loopback/Tailscale y simplificar la firma.
  - `src/application/backend-config.ts`, `src/storage/credential-profile.ts`:
    aceptar `http:` no-loopback.
  - `src/cli/commands/{init,link,login}.ts`: warning + campo `warnings`.
  - Helper de warning compartido y flag global `--no-warnings`
    (`src/cli/dispatch.ts`: `BOOLEAN_FLAGS`, allowlist global, `HELP_TEXT`).
  - Tests: `test/server-runtime.test.mjs`, `test/backend-config.test.mjs`,
    `test/credential-profile.test.mjs`, `test/cli-link.test.mjs`,
    `test/cli-login.test.mjs`, `test/init.test.mjs`,
    `test/application-backend-client.test.mjs`.
  - Docs: `README.md`, `docs/reference.md`, `docs/remote-server.md`, `CHANGELOG`.
  - ADRs derivados (abajo).
- **Fuera:**
  - Auth, lock de servicio, rate limit, formato de errores y persistencia.
  - `init --force` remoto y el resto de las reglas de Remote v1.
  - Implementar TLS/reverse proxy: sigue siendo del operador.
  - Despliegue de `agento` (binario/unit/`uiRoot`) y el retiro mecanico del
    parche en `deploy-base`: tareas aparte, no parte de este ADR.
  - La UI (`ui/`).

## Decisiones de cierre de review

- **Warning solo `http:` no-loopback.** Loopback HTTP no cruza red; HTTPS no
  avisa.
- **`<origin>` del warning**: `new URL(backend.url).origin`, sin path; idéntico
  en `login`, `link` e `init`.
- **`--no-warnings` es flag, no env.** Debe aceptarse antes y después del
  comando (allowlist global + `BOOLEAN_FLAGS` + `HELP_TEXT`).
- **Host de bind inválido**: no se valida sintaxis. Si el SO no puede bindear,
  falla en `listen` después de preparar `stateHome`, `dataRoot`, auth y lock. Se
  documenta la consecuencia (incluida una posible rotación de auth antes de un
  bind fallido) y se agrega una regresión de que el lock se libera al fallar.
- **Referencias normativas a los flags removidos**: ADR-028 se marca superseded
  y la cláusula loopback de ADR-043 se enmienda; ADR-027 §ADRs vinculados,
  ADR-046 §6 y `.decisions/G-remote-v1-cut-rfc.md` se marcan históricos (dejan
  de ser guía operativa). Búsqueda final de referencias en la verificación.
- **Invariantes preservadas**: rate limit por dirección, lock
  `stateHome/.server.lock`, password por TTY, bearer hasheado y sin fallback
  local no dependen de la política de red y no cambian.

## Riesgos aceptados

- El operador puede exponer un `http:` no-loopback con password y bearer sin
  cifrar. La defensa es el warning en `login`/`link`/`init` más los docs; es su
  decisión, no la de climier.
- Remover `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` y
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP` es breaking para scripts que las setean:
  no fallan, se ignoran. Va en `CHANGELOG`.

## Verificación

- `bunx tsc -p tsconfig.json` → exit 0; `bun scripts/type-budget.ts` →
  `"ok": true`.
- `bun run test` verde con los tests migrados.
- Server: bind a `0.0.0.0`, `::`, `localhost`, IP de interfaz y loopback arranca
  sin env; `listen` malformado (`{}` o host no-string) sigue fallando con
  `INVALID_SERVER_CONFIG`; un bind fallido libera el service lock.
- Cliente: `http:` no-loopback se acepta sin env y produce
  `warnings[0].kind === "insecure-remote-http"` en `login`, `link` e `init`;
  HTTPS y loopback HTTP no lo producen; `--no-warnings` (antes y después del
  comando) elimina `warnings` sin cambiar el resto del resultado.
- `git grep` final: `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` y
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP` solo aparecen en docs históricos
  marcados.
- Docs actualizadas (`README.md`, `docs/reference.md`, `docs/remote-server.md`)
  y `CHANGELOG`.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-051: Server listener sin politica de red; climier no exige loopback →
  `.adrs/051-server-listener-no-network-policy.md` (enmienda ADR-043; elimina el
  parche Tailscale).
- [ ] ADR-052: Transporte remoto: warnings en vez de gate HTTPS y flag
  `--no-warnings` → `.adrs/052-remote-transport-warnings.md` (supersede ADR-028).
