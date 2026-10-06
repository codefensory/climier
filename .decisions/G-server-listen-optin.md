# RFC: Server listener network boundary (SUPERSEDED)

> Estado: **descartada**. Esta propuesta (opt-in genérico/no-loopback) fue
> reemplazada por `G-network-boundary` (`.decisions/G-network-boundary.md`),
> que quita de climier toda la política de boundary de red. Se conserva solo
> como trazabilidad.

- Gate: `G-server-listen-optin` · Iniciativa: `remote-cloud-service` · Estado: descartado
- Autor: orchestrator · Fecha: 2026-10-06

## Problema

El server remoto solo puede bindear a loopback (`src/server/runtime-config.ts`;
ADR-043 §Decision). La postura por defecto es correcta: climier no quiere ser la
capa de exposicion de red, y un bind no-loopback en HTTP plano expone el password
de login y el bearer. Pero hoy no existe ninguna via soportada para un operador
que si quiere bindear una interfaz propia.

El host de produccion `agento` (`to-all`) lo esquivo con un parche out-of-tree
(`deploy-base` `98c941b`) que acepta **unicamente** el IPv4 asignado a
`tailscale0` detras de `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP=true`. Ese parche:

- acopla el producto a Tailscale, que es infraestructura del operador y no un
  concepto de climier;
- no cubre otros binds legitimios (`0.0.0.0` para una LAN, otra interfaz, una
  red de contenedores);
- ya esta duplicado en la rama TS (`144849d` + `260eea2`), con una tarea de
  upstream (`T-remote-server-tailscale-listener`) **cancelada**, asi que la
  unica via soportada sigue siendo el parche de vendor.

La alternativa "loopback + `tailscale serve`" funciona y no toca codigo, pero el
operador pidio explicitamente poder bindear `0.0.0.0` (acceso LAN directo, no
solo tailnet). Este RFC resuelve el contrato del listener para ese caso.

## Propuesta

Reemplazar el parche especifico de Tailscale por **un unico opt-in generico y
explicito** en la validacion de `listen.host`:

- `listen.host` sigue siendo loopback por defecto y loopback es siempre valido.
- Si `listen.host` no es loopback, el server arranca solo cuando
  `CLIMIER_SERVER_ALLOW_REMOTE_HTTP=true` (valor exacto). Variable ausente o con
  cualquier otro valor sigue fallando con `INVALID_SERVER_CONFIG` **antes de
  escuchar**.
- Con el opt-in activo se acepta cualquier direccion, incluidos `0.0.0.0`/`::`
  (wildcard) y una IP concreta.
- La linea de salud del launcher (`{ ok, host, port }`) agrega un campo aditivo
  de warning cuando el bind no es loopback, con el host efectivo.
- Se elimina `isTailscaleIPv4`, `assignedToTailscale0` y
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP`; el parche de `deploy-base` queda
  obsoleto.

El default seguro no cambia: sin opt-in, no-loopback se rechaza. Lo que cambia
es que el operador tiene una via soportada y sin vendor lock-in para habilitarlo.

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| A. Loopback-only + proxy/tunel externo (status quo) | Cero codigo; postura mas segura; ya cubierta por ADR-043/028 | Obliga a un proxy/TLS o `tailscale serve`; no satisface un bind LAN directo pedido por el operador |
| B. Opt-in especifico de Tailscale (parche actual) | Minimo privilegio: solo la IP real de `tailscale0`, y solo con el flag | Acopla el producto a un vendor; no autoriza `0.0.0.0` ni otras interfaces; deja el parche duplicado y sin upstream |
| C. **Opt-in generico `CLIMIER_SERVER_ALLOW_REMOTE_HTTP=true` (recomendada)** | Un solo contrato, sin vendor; cubre `0.0.0.0`, IP de interfaz y overlay; fail-closed intacto; testeable | Debilita la friccion: el operador puede exponer HTTP plano con un solo flag; riesgo real en redes no confiables |
| D. Bind libre sin opt-in | Maxima comodidad | Expone credenciales en HTTP plano por defecto; rompe fail-closed; inaceptable |

## Alcance

- **Dentro:**
  - `src/server/runtime-config.ts`: reemplazar la validacion de Tailscale por el
    opt-in generico; `parseServerRuntimeConfig` conserva el `options` inyectable
    para tests (`allowRemoteHttp`, `networkInterfaces` se puede retirar).
  - `src/server/runtime.ts` / `bin/climier-server.ts`: warning aditivo en la
    linea de salud cuando el bind no es loopback.
  - `test/server-runtime.test.mjs`: aceptacion (loopback siempre; no-loopback con
    opt-in; wildcard con opt-in) y rechazo (sin opt-in, valor distinto de
    `true`, host invalido).
  - `docs/remote-server.md`: documentar el flag, el riesgo (HTTP plano fuera de
    loopback, password y bearer al descubierto) y la relacion con el opt-in de
    cliente `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP`.
  - `docs/reference.md`: actualizar la linea "el server sigue bindeando a
    loopback".
  - Retiro del parche de vendor (`144849d`/`98c941b`), incluida la nota de
    `deploy-base`.
- **Fuera:**
  - Auth, rutas/header, persistencia, rate limiting y el default loopback.
  - El opt-in de cliente (`CLIMIER_ALLOW_INSECURE_REMOTE_HTTP`), que no cambia.
  - Implementar TLS/reverse proxy; exponer HTTPS sigue siendo
    responsabilidad del operador.
  - El build/unit/systemd de `agento` (es despliegue, tarea aparte).

## Riesgos y open questions

- **Exposicion de credenciales en HTTP plano.** Con `0.0.0.0` + opt-in, el login
  y el bearer viajan sin TLS. → Mitigacion: flag explicito con valor exacto,
  warning en la linea de salud, doc del threat model, default loopback intacto, y
  recomendacion de tailnet/TLS/LAN confiable.
- **Wildcard vs IP concreta.** ¿Un solo flag para ambos, o un escalon extra para
  `0.0.0.0`/`::`? → El RFC propone un solo flag; lo dejo como open question para
  los reviewers (mas simple vs mas friccion de seguridad).
- **`x-forwarded-for` y rate limit.** `src/server/auth/login-rate-limiter.ts`
  solo confia en `x-forwarded-for` cuando el peer es loopback. Con bind directo
  no-loopback el rate limit se aplica por peer real (bien), pero detras de un
  proxy en otro host el header se ignora. → Documentar el comportamiento; no
  cambiarlo en este alcance.
- **Nombre del flag.** `CLIMIER_SERVER_ALLOW_REMOTE_HTTP` (simetrico con el flag
  de cliente) vs `..._ALLOW_NON_LOOPBACK` (mas preciso sobre el bind). → Open
  question para los reviewers.
- **ADR-043.** Esta decision **enmienda** su clausula "loopback-only"; no
  reemplaza el ADR completo (auth, lock, rotacion siguen vigentes).

## ADRs derivados (se completa al aprobar)

- [ ] ADR-051: Contrato del listener del server: opt-in generico para
  bind no-loopback → `.adrs/051-server-listener-network-boundary.md`
