# ADR-051: Server listener sin política de red

- Gate: `G-adr051-server-listener` · Deriva de: `G-network-boundary` · Estado: aprobado
- Fecha: 2026-10-06
- Enmienda: ADR-043, sección "Decisión" (cláusula "el listener solo puede
  bindear a loopback"). El resto de ADR-043 (password único, bearer hasheado,
  lock de servicio, rotación) sigue vigente.

## Contexto

ADR-043 restringió el listener del server a loopback para mantener a climier
fuera de la capa de exposición de red. En la práctica el host de producción
`agento` necesita bindear el IPv4 de su tailnet, y como no había vía soportada
el deploy mantuvo un parche out-of-tree (`deploy-base` `98c941b`) con
`isTailscaleIPv4`, `assignedToTailscale0` y el opt-in
`CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP=true`; el port a TS lo duplicó (`144849d`).

Ese parche mete un vendor (Tailscale) dentro del producto, no cubre otros binds
legítimos (`0.0.0.0`, otra interfaz, una red de contenedores) y deja la
validación de red como responsabilidad de la herramienta. Exponer (o no) el
server es decisión del operador.

## Decisión

Eliminar toda la política de red de `listen.host`: no hay validación de loopback,
de IP, de interfaz ni de rango Tailscale.

- `listen.host` acepta cualquier `string` no vacío; el bind es responsabilidad
  del operador.
- Se eliminan `isLoopbackHost`, `isTailscaleIPv4`, `assignedToTailscale0`,
  `allowedListenHost`, la opción `networkInterfaces`, el error de loopback y la
  variable `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP`.
- `parseServerRuntimeConfig(value)` pierde su parámetro `options`.
- No se emite ningún warning del lado del server; los avisos de red viven en el
  cliente (ADR-052).
- Si el SO rechaza el bind, el error ocurre en `server.listen` **después** de
  preparar `stateHome`, `dataRoot`, el auth store y el service lock. Esa
  consecuencia se documenta; no se reordena el arranque.

## Consecuencias

- **A favor:** climier deja de policiar dónde se hostea; sin vendor lock-in; se
  elimina el parche de `deploy-base`; una sola regla de shape (string no vacío).
- **En contra / deuda:** un host inválido falla tarde (y una rotación de auth
  puede haber quedado persistida antes del fallo); el operador puede exponer
  HTTP plano si no pone TLS o un overlay. Los docs deben advertirlo.
- **Sin cambios:** password por TTY, bearer hasheado, lock
  `stateHome/.server.lock`, rate limit de login y la ausencia de fallback local.

## Plan de implementación

1. Validación del listener — `src/server/runtime-config.ts` (y `runtime.ts` si
   hiciera falta): quitar la política y simplificar la firma.
2. Tests — `test/server-runtime.test.mjs`: aceptar `0.0.0.0`, `::`, `localhost`,
   IP de interfaz y loopback; rechazar shapes inválidos con
   `INVALID_SERVER_CONFIG`; un bind fallido libera el service lock.
3. Docs — `docs/remote-server.md`: quitar "must be loopback" y describir la
   responsabilidad del operador (se completa en la task de docs de ADR-052).
4. Retiro del parche de deploy — `deploy-base` `98c941b` y la env var en
   `agento` (tarea de despliegue aparte; fuera de este ADR).

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR ya permite crear una task clara (listener + tests);
  la documentación viaja en la task de docs de ADR-052 y el despliegue de
  `agento` es una task separada fuera de ambos ADRs.

## Verificación

- `bunx tsc -p tsconfig.json` → exit 0; `bun scripts/type-budget.ts` →
  `"ok": true`; `bun run test` verde.
- `listen.host` en `0.0.0.0`, `::`, `localhost`, una IP de interfaz y
  `127.0.0.1` arranca sin ninguna variable de entorno adicional.
- `listen` malformado (`{}` o host no-string) falla con `INVALID_SERVER_CONFIG`
  antes de `listen`.
- Un bind rechazado por el SO no deja el `stateHome/.server.lock` tomado.
