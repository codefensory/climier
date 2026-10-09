# ADR-068: Un solo binario para el runtime remoto

- Estado: aprobado
- Enmienda: ADR-060 (no lo supersede); también actualiza el `ExecStart` decidido en ADR-059
- Fecha: 2026-10-09

## Decisión

`climier server run <config>` es la única superficie para iniciar el runtime
Remote v1. Se elimina el binario instalado `climier-server` y `package.json`
publica solamente `climier`.

El unit systemd generado conserva el nombre de servicio por compatibilidad,
pero su `ExecStart` invoca `server run`. La ruta se resuelve según la
clasificación de distribución de ADR-060/064:

- En una instalación npm se usa el runtime absoluto (`process.execPath`) y la
  ruta absoluta al `bin/climier.ts` del paquete; nunca el shim de npm.
- En una distribución standalone se usa el `process.execPath` absoluto, que es
  el binario `climier` compilado, seguido por `server run` y la configuración.

El binario conserva el comportamiento observable del launcher retirado: emite
`{ok,host,port}` después del bind, permanece en foreground y cierra limpiamente
con `SIGINT` o `SIGTERM` (exit 0; exit 1 si falla el cierre). `server doctor`
continúa siendo el único preflight y no tiene una variante `--check` separada.

## Consecuencias

- El build standalone compila una entrada por target en vez de dos.
- Los operadores instalan y actualizan una sola superficie (`climier`).
- El nombre `climier-server.service` puede permanecer como identidad del unit;
  no representa un segundo ejecutable.
- Los units generados antes de esta enmienda deben regenerarse para cambiar su
  `ExecStart`; no se usa `init --force` como migración implícita.

## Verificación

- `package.json` no declara `bin.climier-server` y el tarball solo expone
  `.bin/climier`.
- `server run` se prueba con arranque, health JSON y shutdown por `SIGTERM`.
- El renderer del unit se prueba con las clasificaciones npm y binary, y las
  instrucciones de `docs/remote-server.md` no invocan el launcher retirado.
