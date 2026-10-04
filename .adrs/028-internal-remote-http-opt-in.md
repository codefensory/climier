# ADR-028: HTTP interno remoto con opt-in explícito

- Gate: `G-rb-internal-http-transport` · Deriva de: `G-rb-minimal-v1` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

ADR-027 exige HTTPS para un backend remoto fuera de loopback porque el cliente puede enviar un bearer. Esa es la postura correcta por defecto y sigue siendo el contrato de producto.

Para pruebas y operación exclusivamente internas, un operador puede tener una red deliberadamente confiable donde quiere conectar el cliente directamente a un listener HTTP remoto, sin desplegar TLS, Tailscale Serve o un túnel SSH. La validación actual rechaza esa URL antes de cualquier request.

La excepción no debe quedar grabada en `.climier.json`, desactivar autenticación, debilitar la aprobación de origen, cambiar el servidor ni introducir ruido en los resultados JSON que consumen agentes.

## Decisión

### HTTPS permanece como comportamiento por defecto

- `https:` sigue siendo obligatorio para cualquier backend remoto no-loopback salvo la excepción siguiente.
- `http:` sigue permitido sin opt-in para loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) como hoy.
- URLs con userinfo, query o fragment siguen rechazadas. `.climier.json` sigue conteniendo únicamente `backend.type` y `backend.url`; no contiene tokens ni un flag inseguro persistente.

### Excepción interna de plaintext

Un cliente permite `http:` remoto no-loopback únicamente si el operador exporta exactamente:

```sh
CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true
```

La variable es una excepción interna, no una capacidad de producto ni una recomendación de despliegue. Su presencia no prueba que la red sea segura: el operador asume que la confidencialidad e integridad de transporte son responsabilidad de su red privada, firewall o túnel externo.

El servidor no requiere cambio de modo. La excepción ocurre solamente en la admisión de configuración del cliente: el servidor ya opera HTTP tras loopback, un proxy TLS o una red privada y no puede determinar de modo fiable si TLS terminó antes de recibir el request.

### Controles que siguen obligatorios

Con o sin la excepción:

- Si hay bearer, `CLIMIER_REMOTE_ORIGIN` debe coincidir exactamente con `new URL(backend.url).origin` antes de enviar el token. Para este modo, el origin será `http://<host>[:port]`.
- `CLIMIER_TOKEN` continúa fuera del checkout y `.climier.json`.
- Auth bearer, scope por proyecto, catálogo server-side, aislamiento de paths, API tipada, ledger/fence y rechazo sin fallback local permanecen sin cambio.
- Ausencia o discordancia de la aprobación de origin sigue fallando antes de emitir una request autenticada.

### Warning de bootstrap, no de cada comando

El CLI raíz conserva el contrato de un único JSON por stdout y stderr vacío en resultados normales. Por tanto no imprime `console.warn` ni agrega una segunda salida.

Cuando `climier init` usa un backend remoto `http:` no-loopback permitido por el opt-in, añade a su resultado el campo aditivo:

```json
{
  "warnings": [
    {
      "kind": "insecure-remote-http",
      "severity": "warning",
      "message": "init: remote HTTP is enabled by CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true; bearer credentials are sent without transport encryption. Internal trusted networks only."
    }
  ]
}
```

- El warning se muestra solo cuando `init` remoto plaintext termina exitosamente. Si init encuentra state existente, auth inválida, origin no aprobado, fallo de red o protocolo, conserva sin campos adicionales el envelope de error actual.
- Otros comandos no cambian su envelope ni emiten warnings repetidos; los agentes conservan resultados sin ruido adicional.
- El warning no reemplaza ningún error: origin no aprobado, auth inválida, fallo de red y protocolo siguen siendo fail-closed.

## Consecuencias

- A favor: habilita pruebas y uso interno sobre una red explícitamente confiable sin obligar a desplegar TLS para cada entorno efímero.
- A favor: la excepción es visible, reversible y no queda versionada en el checkout; eliminar la variable devuelve el rechazo seguro predeterminado.
- A favor: preserva origin binding, auth/scope, catálogo, transporte tipado y ausencia de fallback local.
- En contra / deuda: un bearer puede viajar sin cifrado ni protección contra modificación si la red no cumple la confianza asumida. Tailscale, una red privada o el origin binding no sustituyen TLS por sí mismos.
- En contra / deuda: el warning de `init` no prueba que operadores posteriores comprendan el riesgo; la documentación debe mantener HTTPS como ruta recomendada.
- Fuera: HTTP plaintext como configuración de producto, un flag en `.climier.json`, relajación de origin binding, servidor TLS integrado, autoevaluación de topología/red, y cambios a UI/plugins/sync/transferencias.

## Plan de implementación

1. **Admisión de configuración y client context** — archivos: `src/application/backend-config.mjs`, `src/application/backend-client.mjs`, `test/backend-config.test.mjs`, `test/application-backend-client.test.mjs`.
   - Permitir HTTP no-loopback solo bajo la variable exacta; conservar binding de origin antes del bearer y exponer el contexto inseguro sin secretos.
2. **Warning limitado a init** — archivos: `src/cli/commands/init.mjs`, sus pruebas y las pruebas JSON/CLI necesarias.
   - Añadir el warning JSON únicamente para init remoto plaintext habilitado, sin alterar envelopes de otros comandos ni stderr.
3. **Documentación y hardening de seguimiento** — archivos: `docs/remote-server.md`, documentación de output aplicable y tests de regresión.
   - Documentar threat model, activación, reversión y que HTTPS sigue siendo recomendado; crear backlog para definir si el modo puede evolucionar fuera de uso interno.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — tras aprobar, revisar el parser de backend, construcción de backend client, retorno de init y contratos JSON para dividir por ownership sin solapar paths.

## Verificación

- Sin `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true`, una URL `http:` no-loopback se rechaza como hoy; loopback sigue funcionando.
- Con el opt-in exacto, la misma URL se acepta, pero un bearer sin `CLIMIER_REMOTE_ORIGIN` exacto sigue retornando `REMOTE_ORIGIN_NOT_APPROVED` sin request.
- Con token y origin HTTP exactos, el transporte realiza una única request autorizada a una URL HTTP no-loopback y conserva el no-fallback local ante auth/red/protocolo.
- `init` remoto plaintext exitoso responde con el warning JSON estructurado; init HTTPS, init loopback e init local no lo incluyen. Errores de init plaintext conservan el envelope de error actual, sin warnings aditivos.
- Una variable ausente o con cualquier valor distinto de `true` sigue rechazando HTTP no-loopback.
- Todos los stdout de CLI siguen siendo un solo JSON válido y stderr queda vacío; `npm test` y `git diff --check` pasan.
