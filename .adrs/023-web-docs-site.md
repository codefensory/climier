# ADR-023: Sitio de documentación web

- Gate: `G-adr023-web-docs-site` · Deriva de: `G-adr023-plan-artifact-location` (gate anterior, supersedido) · Estado: aprobado
- Fecha: 2026-09-24

## Contexto

La documentación de Climier está distribuida entre `docs/`, `docs/plans/`, `.adrs/`, `.decisions/` y algunos archivos Markdown de nivel raíz. Los documentos enlazan entre sí principalmente mediante rutas escritas como código inline; sin una vista navegable, esas referencias no son enlaces utilizables. El repositorio ya tiene una UI Solid aislada en `ui/`, pero no un sitio para leer la documentación.

Se necesita una experiencia de lectura y búsqueda que reutilice las fuentes Markdown existentes sin moverlas, cambiar su idioma o añadir dependencias de interfaz al CLI. También es importante que la lista pública incluya los directorios ocultos `.adrs/` y `.decisions/`, que los conteos cambien con el contenido real y que los documentos fuente, que no usan frontmatter, se puedan procesar de forma fiable.

## Decisión

1. El sitio vive en `web/` como subproyecto autónomo con su propio `package.json` y lockfile. Usa Fumadocs sobre TanStack Start, React y Vite. No comparte dependencias ni código de runtime con `ui/`, y no añade dependencias al CLI ni incorpora `web/` al paquete npm de Climier.
2. El sitio es una proyección de solo lectura. Las fuentes permanecen en su ubicación y formato existentes. El sitio no modifica el estado Climier ni las fuentes Markdown.
3. `web/scripts/gen-content.mjs` genera un espejo Markdown dentro de `web/content/`, con títulos derivados del primer encabezado H1. Los archivos del espejo conservan extensión `.md`: el corpus es Markdown normal y no debe procesarse como MDX. El frontmatter necesario para Fumadocs se genera en el espejo, nunca se añade a los documentos fuente.
4. El inventario público se deriva de directorios permitidos explícitamente —`docs/`, `docs/plans/`, `.adrs/` y `.decisions/`— y de una lista limitada de documentos raíz/opcionales mantenida por el generador. No se fija un número esperado de páginas; el manifiesto es la fuente de verdad para slugs, títulos y secciones.
5. Un transformador Remark convierte referencias conocidas a rutas de documentos escritas en código inline en enlaces navegables. No transforma ejemplos dentro de bloques de código ni referencias que no estén en el inventario.
6. La interfaz ofrece navegación agrupada, tabla de contenidos, páginas anterior/siguiente, búsqueda y tema oscuro. El servidor de desarrollo/preview usa el puerto 4400 para evitar el puerto 3000 ocupado en el entorno de implementación.
7. El despliegue público y un dominio público quedan fuera de alcance. El sitio no añade autenticación; cualquier binding accesible desde una red debe limitarse a una red confiable y no exponerse a Internet abierto.
8. `npm run test:docs` genera el contenido, construye el sitio y verifica que cada slug del manifiesto responda HTTP 200 con un `<h1>` no vacío, además de comprobar que una ruta inexistente responda 404. CI ejecuta esta comprobación como job separado.

## Consecuencias

- A favor: los lectores pueden navegar la documentación existente y sus referencias internas; los directorios ocultos permitidos se incluyen intencionalmente; la cantidad de páginas sigue automáticamente el contenido; el CLI y el paquete npm mantienen su superficie y dependencias independientes.
- En contra / deuda: el subproyecto tiene un árbol de dependencias propio y requiere su verificación separada; los cambios al corpus deben seguir siendo compatibles con el generador y el transformador.
- El binding en una red confiable no equivale a autenticación. No se debe publicar el sitio en una red no confiable sin añadir un control de acceso apropiado.

## Implementación y verificación

La decisión está implementada en `web/`, con el script raíz `test:docs`, el job `docs-site` de CI y las instrucciones de operación en la documentación del repositorio. Verificado en esta rama:

- `node web/scripts/verify-docs-site.mjs` — 43/43 rutas del manifiesto respondieron 200 con `<h1>` no vacío; una ruta desconocida respondió 404.
- `node --test web/test/links.test.mjs` — 17 pruebas aprobadas.
- `bun run --cwd web build` — build de producción completado.
- `npm run pack:check` — el chequeo de empaquetado del CLI completado; `web/` queda fuera del tarball.

## Onboarding breve para crear tasks

- [x] No hace falta — la decisión y la implementación del sitio ya están completas; no se desprenden tareas nuevas de este ADR.
