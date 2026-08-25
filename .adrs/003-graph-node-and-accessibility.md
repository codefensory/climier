# ADR-003: Nodos, semantic zoom, paleta light y contrato accesible

- Gate: `G-ui-graph-adr-003` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

Cytoscape pinta nodes en canvas y no crea semántica DOM. El overlay actual crea un botón por node, sincronizado en cada render. Graph 2.0 necesita cards con tres niveles de zoom, pero no debe mantener contenido DOM rico para 200 nodos fuera de viewport ni perder una ruta de teclado hacia nodos no visibles.

El Graph queda en light mode. CSS variables son la fuente de verdad visual; canvas requiere valores computados. La política aprobada para Graph 2.0 es **A: no crear ni modificar archivos bajo `test/`**. La accesibilidad se verifica con build y recorridos manuales de teclado documentados, preservando sin edición los tests existentes.

## Decisión

### Paleta y alcance de renderer

`index.css` y sus `--ui-*` siguen siendo la fuente canónica de color. Se agrega `ui/src/views/graph-palette.mjs`, que exporta nombres semánticos de variables y `readGraphPalette(root)`; en montaje de navegador usa `getComputedStyle(root)` para obtener valores concretos. `Graph.jsx` construye el stylesheet de Cytoscape mediante `createGraphStyle(palette)`; no duplica hex en `CY_STYLE`.

La portabilidad aplica a selectores y layout puro. Cytoscape es el renderer comprometido para v1; sustituirlo es una decisión futura, no una promesa implícita de esta ADR.

### Tiers de zoom

Con zoom permitido 0.25–2.5, las bandas son discretas:

| Tier | Rango estable | Representación |
|---|---|---|
| `overview` | `< 0.65` | glyph/marker y estado; sin texto ilegible |
| `compact` | `0.65–<1.15` | ID, título abreviado y estado/rol |
| `detail` | `≥ 1.15` | card de tipo con metadatos operacionales mínimos |

Para evitar flicker, el tier usa histéresis de 0.05 alrededor de cada frontera: no cambia hasta atravesar el umbral más/menos el margen desde el tier actual. El cálculo ocurre solamente en eventos de zoom, Fit, Reset o resize; nunca por frame/render.

Task, Gate y Knowledge se distinguen por rol, shape/glyph y texto; color no es la única señal.

### Overlay, teclado y fallback estrecho

Los botones overlay/cards DOM se montan solo para nodes dentro de viewport con margen de 96 px y en el tier que requiera contenido DOM. Mantienen nombre accesible, título, foco visible, Enter/Space, Escape y gesto drag→pan.

El camino de teclado para **todos** los nodes no depende de botones off-viewport: Finder existente es la vía canónica de búsqueda/teclado global (`/` o Ctrl/Cmd+K). Desde Graph, elegir un resultado selecciona y enfoca/camera-fit el node cuando pertenece al modo actual; si no pertenece, informa y ofrece cambiar al modo correspondiente. No se crea un segundo navigator, árbol ni drawer.

En pantalla estrecha no se miniaturiza el canvas: Graph ofrece Finder y `NodeDetail` existente como fallback. No se duplican resultados, detalle ni navegación de `Finder.jsx`/`NodeDetail.jsx`. Cualquier cambio de detalle se realiza en la tarea aislada de ADR-001.

### Alcance de rendimiento

La baseline de 200 nodos es una dependencia satisfecha (`T-ui-graph-benchmark` y `T-ui-graph-renderer-baseline`). El tier y culling se verifican sobre ese fixture mediante benchmark/manual documentado; no cambian la semántica de pan/zoom ni fuerzan relayout por frame.

## Consecuencias

- La capa DOM accesible es intencional, pero no reproduce 200 cards completas en cada render.
- Finder preserva acceso por teclado a nodes fuera del viewport sin un orden de Tab infinito.
- Canvas y DOM comparten tokens CSS computados sin una segunda paleta de hex mantenida a mano.
- Los tests existentes se preservan intactos; no se agregan suites de tiers/a11y por la política A.

## Acceptance para la decisión

- Fuente de paleta, lectura browser-only y construcción de stylesheet Cytoscape están definidas.
- Thresholds, histéresis y disparadores de tier son numéricos y deterministas.
- Culling viewport, margen y ruta Finder para nodes no visibles están definidos.
- Teclado, foco, Escape, drag→pan y fallback estrecho reutilizan componentes existentes.
- Cytoscape queda explícitamente como renderer v1; no se cambia `test/`.

## Plan por piezas candidato

1. **Paleta:** `graph-palette.mjs` y stylesheet factory; no modifica zoom ni navegación.
2. **Representación:** Graph usa paleta, tipos y tiers; depende de 1 y no toca `NodeDetail`.
3. **Overlay/fallback:** viewport culling, Finder→Graph focus y fallback estrecho; depende de 2, reutiliza Finder/NodeDetail sin modificarlos.
4. **Verificación:** benchmark fixture + build + teclado/pan/zoom manual documentado; no es una task de código separada.
