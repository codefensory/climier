# ADR-003: Nodos, semantic zoom, paleta light y contrato accesible

- Gate: `G-ui-graph-adr-003` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

Cytoscape pinta los nodos en canvas; no produce semántica DOM. El Graph actual compensa con un botón transparente por cada node sincronizado en cada render. Graph 2.0 necesita cards informativas y tres niveles de zoom, pero 200 cards DOM sincronizadas en pan continuo pueden degradar interacción y accesibilidad.

El Graph debe seguir light. Canvas no consume CSS variables, por lo que `CY_STYLE` hoy duplica hex que también viven en `index.css`.

## Decisión propuesta

1. Crear un mapa de paleta versionado para Graph (`graph-palette.mjs` o equivalente) que traduzca tokens semánticos light a valores consumibles por canvas; CSS/DOM y Cytoscape usan la misma fuente de nombres y no hex dispersos.
2. Definir tres tiers de zoom por bandas discretas, no por frame:
   - **detail:** card task/gate/knowledge completa y metadatos mínimos;
   - **compact:** ID, título y estado/rol;
   - **overview:** glyph/marker legible, sin texto ilegible.
3. Renderizar contenido DOM rico solo para elementos dentro de viewport y el tier que lo necesite. El resto conserva hit target y una alternativa navegable por teclado; nunca se pierde el nombre accesible.
4. Mantener botones DOM reales, nombre accesible, título, foco visible, Enter/Space, Escape y gesto drag→pan. Añadir navegación alternativa de lista/búsqueda para viewport estrecho.
5. Diferenciar tipos por rol, shape/glyph y texto; color no es la única señal.
6. Execution vacío, single initiative y History deben tener representaciones light específicas sin estados vacíos genéricos.

## Consecuencias

- La capa accesible deja de ser solo un parche invisible y pasa a formar parte del sistema de representación.
- El renderer no puede sustituirse sin volver a validar el contrato DOM/teclado.
- Mobile prioriza búsqueda, lista, foco y `NodeDetail`, en lugar de un canvas miniaturizado.

## Acceptance para la decisión

- Mapa de paleta light y responsabilidades CSS/canvas están definidos.
- Tier thresholds, contenido por tier y reglas de viewport están definidos.
- Contrato de teclado, foco, nombre accesible, selección, Escape y drag está especificado.
- Fallback de pantalla estrecha es navegable sin depender del canvas.
- Declara qué comprobaciones de helpers son renderer-agnostic y cuáles verifican la capa accesible del renderer activo.

## Plan por piezas candidato

1. Paleta semántica y estilos de tipo/estado.
2. Overlay/tier/culling accesible.
3. Controles y fallback estrecho.
4. Revisión visual y de teclado integrada con Execution/History.
