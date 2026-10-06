# ADR-052: Transporte remoto con warnings en vez de gate HTTPS

- Gate: `G-adr052-remote-transport` · Deriva de: `G-network-boundary` · Estado: aprobado
- Fecha: 2026-10-06
- Supersede: ADR-028 (alcanzado por el gate `G-rb-internal-http-transport`).

## Contexto

ADR-028 exige `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true` para aceptar un origin
`http:` no-loopback, y aclara que el server mantiene su listener. Es un segundo
gate, distinto del bind, para una decisión de riesgo que pertenece al operador:
en la práctica el checkout de este repo está linkeado a
`http://100.127.228.54:43127/` y la variable está siempre presente solo para
pasar la validación.

Bloquear el transporte no mejora la seguridad real (el operador puede exportar la
variable) y agrega fricción. Un warning estructurado comunica lo mismo sin
decidir por el usuario.

## Decisión

Reemplazar el gate por un warning no bloqueante.

- `parseBackendConfig` acepta `http:` y `https:` sin variable de entorno y
  calcula `insecureRemoteHttp = protocolo http && host no-loopback`.
- `normalizeOrigin` acepta origins `http:`/`https:` sin userinfo; se elimina
  `permitsHttpOrigin` y la dependencia de `allowInsecureRemoteHttp`.
- `login`, `link` e `init` (remoto) agregan el campo aditivo `warnings` con
  `{ kind: "insecure-remote-http", severity: "warning", message: "<command>: <origin> is not HTTPS; the login password and bearer travel without transport encryption." }`
  solo cuando el origin es `http:` no-loopback. `<origin>` es
  `new URL(backend.url).origin` (scheme://host[:port], sin path).
- Flag global `--no-warnings` (aceptado antes o después del comando) suprime el
  campo `warnings` sin cambiar el resto del resultado.
- Se elimina `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` del código y de los docs
  operativos.
- **No cambia:** password por TTY, bearer hasheado server-side, perfil `0600` por
  origin, origin sin userinfo/query/hash, rate limit, lock de servicio y la
  ausencia de fallback a estado local.

## Consecuencias

- **A favor:** una sola superficie de aviso; sin flag duplicado; sin fricción
  para redes confiables.
- **En contra / deuda:** un origin `http:` no-loopback se acepta por defecto y el
  password/bearer viajan sin cifrar; el warning es la única defensa. Remover
  `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` es breaking para scripts que la setean (no
  fallan, se ignora): va en `CHANGELOG`.
- Loopback HTTP no avisa porque no cruza la red.

## Plan de implementación

1. Aceptación de HTTP — `src/application/backend-config.ts` y
   `src/storage/credential-profile.ts`.
2. Warning compartido — helper nuevo + `warnings` en `src/cli/commands/init.ts`,
   `link.ts` y `login.ts`.
3. Flag global — `src/cli/dispatch.ts`: `BOOLEAN_FLAGS`, allowlist global de
   `validateKnownFlags` y `HELP_TEXT`.
4. Tests — `test/backend-config.test.mjs`, `test/credential-profile.test.mjs`,
   `test/application-backend-client.test.mjs`, `test/cli-link.test.mjs`,
   `test/cli-login.test.mjs`, `test/init.test.mjs`.
5. Docs — `README.md`, `docs/reference.md`, `docs/remote-server.md`, `CHANGELOG`;
   marcar ADR-028 como superseded.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR ya fija el contrato y el corte en tres tasks claras
  (aceptación HTTP; warning + flag; docs + ADR-028 superseded).

## Verificación

- `bunx tsc -p tsconfig.json` → exit 0; `bun scripts/type-budget.ts` →
  `"ok": true`; `bun run test` verde.
- Un `http:` no-loopback se linkea, loguea e inicializa sin ninguna env var y el
  resultado incluye `warnings[0].kind === "insecure-remote-http"` con el origin
  exacto.
- HTTPS y loopback HTTP no incluyen `warnings`.
- `--no-warnings` antes y después del comando elimina `warnings` y no cambia el
  resto del resultado.
- `git grep CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` solo aparece en ADR-028
  (marcada superseded) y en el RFC histórico.
