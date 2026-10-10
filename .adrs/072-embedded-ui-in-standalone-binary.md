# ADR-072: UI embebida en el binario standalone

- Gate: `G-ui-embed-binary` · Deriva de: decision de distribucion standalone · Estado: aprobado
- Fecha: 2026-10-10

## Contexto

Los binarios de Climier permiten operar sin Bun ni un checkout, pero el servidor
remoto y `climier ui` necesitan el bundle web. Depender de una carpeta `ui/dist`
externa vuelve incompleta la instalacion standalone y exige distribuir el
source o configurar manualmente cada servidor. Los assets de Bun compilados
viven en `$bunfs`, donde `fs.realpath` no puede resolverlos como archivos
normales.

## Decision

1. **El binario standalone incorpora `ui/dist` como asset.** El build exige
   `ui/dist/index.html` y usa `bun build --compile --asset ui/dist`; CI y release
   smoke construyen la UI antes de compilar.
2. **El runtime sirve el bundle embebido desde memoria.** En la distribucion
   `binary`, el resolver lee recursivamente el directorio de assets relativo al
   ejecutable y crea un mapa de rutas a bytes. No usa `fs.realpath` sobre
   `$bunfs`. npm, source-link y one-off siguen sirviendo desde un directorio del
   filesystem.
3. **El contrato HTTP es compartido.** El handler conserva el fallback SPA,
   `no-cache` para `index.html`, cache immutable para `/assets/*`, content types,
   proteccion contra traversal y el espacio `/v1/*` sin cambios.
4. **`uiRoot` es opcional.** Cuando no se configura, el servidor y `climier ui`
   resuelven el bundle incluido o empaquetado. Se configura una ruta absoluta
   solo para reemplazar el bundle por un build personalizado.
5. **Los binarios standalone no requieren source checkout para `climier ui`.**
   Los builds personalizados quedan soportados mediante `uiRoot` donde el
   servicio o la instalacion necesitan elegir un bundle externo.
6. **No cambia el contrato de `manifest.json` ni `install.sh`.** Los assets
   pertenecen al ejecutable versionado; instalacion, checksum y actualizacion
   siguen describiendo el mismo binario.

## Consecuencias

- A favor: la descarga standalone sirve tanto el servidor remoto como la UI sin
  instalar Bun, mantener un directorio UI adicional o depender del source.
- A favor: CI y el smoke de release ejercitan el mismo ejecutable compilado que
  se publica, incluyendo una peticion `GET /` sin `uiRoot`.
- En contra: el binario aumenta de tamano por el bundle y una UI nueva requiere
  recompilar y publicar el ejecutable.
- Limite: `uiRoot` permite despliegues con assets personalizados, pero no cambia
  el mecanismo de empaquetado de los binarios oficiales.

## Verificacion

- `bun run build:ui && bun run build:binary && bun scripts/smoke-binary.ts dist/climier`
  compila y comprueba el binario host con una configuracion sin `uiRoot`; el
  smoke requiere `GET /` -> `200 text/html` y que el cuerpo coincida con
  `ui/dist/index.html`.
- `bun run smoke:pack` comprueba el paquete npm y el binario standalone.
- En la matriz por tag, CI construye `ui/dist`, compila cada binario de su
  plataforma y ejecuta `bun scripts/smoke-binary.ts "$cli"` antes de publicar
  el artefacto.
- El build sin `ui/dist/index.html` falla con instrucciones para ejecutar
  `bun run build:ui`.
