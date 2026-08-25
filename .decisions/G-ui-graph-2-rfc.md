# RFC: Graph 2.0 — Execution Map light

- Gate: `G-ui-graph-2-rfc` · Iniciativa: `ui` · Estado: aprobado
- Autor: orchestrator, con dirección del usuario · Fecha: 2026-08-25

## Problema

El Graph actual ya usa Cytoscape, dagre LR, zoom/pan, filtros y un overlay accesible. Esa migración resolvió el renderer, pero no el producto: conserva una topología plana donde los tipos de relación y nodos compiten por atención. `BLOCKS` expresa disponibilidad de trabajo; `SUPERSEDES` expresa reemplazo histórico; `DERIVED_FROM` expresa procedencia; knowledge y relaciones legacy aportan contexto. No deben tener el mismo peso visual ni aparecer siempre juntos.

La audiencia es interna: una persona que orquesta trabajo es el usuario primario; una persona/agente que retoma contexto y un validator que audita impacto son secundarios. No es una vista de reporte para stakeholders externos.

**Job principal:** cuando alguien vuelve a un proyecto coordinado, debe poder responder en menos de 30 segundos qué puede avanzar, qué lo bloquea y qué decisión o knowledge explica el bloqueo, sin reconstruir el contexto entre terminal, chat y detalle de nodos.

La UI continúa como proyección local, read-only, del snapshot del CLI. El snapshot se refresca cada 2 s. La experiencia debe operar con 200 nodos sin relayout por cambios no topológicos.

## Propuesta

Rediseñar Graph como un **Execution Map light**: un espacio operacional para orientar, enfocar y explicar trabajo registrado; no una visualización exhaustiva de todos los edges por defecto.

Light mode es una dirección explícita del dueño del producto. La implementación reutiliza y consolida la paleta clara existente; no introduce dark mode ni convierte este RFC en un restyle global de la UI. «Premium» significa jerarquía, densidad controlada, consistencia y respuestas operacionales rápidas; no decoración ni color como única señal.

### Vistas con intención

- **Execution (default):** tareas activas, gates abiertas y `BLOCKS` necesarios para explicar qué se puede ejecutar y qué no.
- **History:** cadenas `SUPERSEDES`, trabajo cerrado y procedencia histórica.
- **All relations:** auditoría avanzada y explícita de todas las relaciones visibles.

Decision, knowledge y contexto no son un cuarto modo. Aparecen en el inspector al seleccionar un nodo, de modo que entender un bloqueo no requiere abandonar Execution.

Los modos son mutuamente excluyentes; búsqueda y filtros se aplican después del conjunto base definido por el modo. El estado de vista no se persiste entre sesiones.

### Gramática espacial y de relaciones

Execution usa un layout determinista propiedad de la aplicación, no compound nodes de `cytoscape-dagre`:

- eje X: rank de dependencias `BLOCKS`, leyendo el edge canónico `from BLOCKS to` como «from bloquea a to»;
- eje Y: lanes por initiative;
- orden de nodos dentro de cada lane: estable y orientado a reducir cruces, sin cambiar la semántica del DAG;
- cruces entre initiatives: se derivan comparando `node.initiative` en ambos extremos; no requieren campos nuevos en edges ni cambios de schema;
- Cytoscape conserva renderer, hit testing, zoom/pan y edges, pero recibe posiciones mediante layout `preset`.

`BLOCKS` es sólido, direccional y dominante. `SUPERSEDES` vive en History o foco. `DERIVED_FROM` e informativas viven en All relations o en contexto de selección. Los labels de edge se revelan en foco/hover, no como ruido continuo. Ciclos, endpoints inexistentes y nodos aislados siguen explicables sin asumir un DAG perfecto.

### Nodos, foco y detalle

- **Task:** card de trabajo con título, estado, initiative y señal de claim/bloqueo relevante.
- **Gate:** card de decisión/aprobación/investigación con propósito e impacto downstream.
- **Knowledge:** contexto compacto y secundario, recuperable desde selección y All relations.

El zoom es semántico: card completa cerca, ID+título+estado a distancia media y glyph/marker legible lejos. Las cards DOM y labels se limitan por viewport y umbral de zoom.

El foco no afirma una ruta crítica inexistente. Ofrece dos acciones explícitas sobre `BLOCKS`:

- **Upstream blockers:** todos los nodos alcanzables hacia atrás.
- **Downstream impact:** todos los nodos alcanzables hacia adelante.

La traversía usa BFS sobre índices de adjacency, protege ciclos y no requiere endpoints nuevos. Focus initiative aísla una initiative preservando conexiones externas relevantes.

La selección reutiliza `NodeDetail`; Graph no crea un inspector paralelo ni reimplementa el drawer. La integración añade estado de vista/foco y una sección contextual mínima, coordinada con el track de detalle para evitar ediciones concurrentes de `NodeDetail.jsx`.

### Accesibilidad, responsive y rendimiento

Cytoscape canvas no expone nodos al DOM. La implementación mantiene una capa DOM accesible sincronizada con el grafo: nombre accesible, foco visible, teclado, selección y Escape. No puede interferir con pan/zoom ni mantener cards detalladas fuera de viewport.

En pantalla estrecha, v1 no intenta miniaturizar el canvas desktop: ofrece búsqueda, lista navegable por teclado, foco y `NodeDetail`.

Antes del layout de producto se crea un fixture determinista de 200 nodos y un benchmark versionado que registra baseline de construcción/layout. Los ADRs posteriores fijan presupuesto concreto y verifican que cambios no topológicos no corran layout. La actualización por polling aplica estilos en lote y conserva posiciones por firma de topología.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| A. Retocar el Graph actual sobre dagre plano | Menor cambio. | No resuelve propósito, jerarquía de relaciones, lanes reales ni densidad. |
| B. Execution Map light con layout rank × initiative propio, foco semántico e inspector integrado — **recomendada** | Representa el modelo real de Climier, mantiene el renderer probado y evita la limitación de compound nodes. | Requiere decisiones explícitas de view model, layout y accesibilidad. |
| C. Sustituir Graph por tablas/board | Más simple. | Pierde orientación espacial y coordinación entre initiatives. |

## Alcance

- Dentro:
  - Propósito operacional, vistas, jerarquía de relaciones e interacción de Graph.
  - Layout `BLOCKS` rank × initiative lanes, semantic zoom, path focus, búsqueda, accesibilidad y presupuesto de rendimiento.
  - Integración coordinada con `NodeDetail` existente.
  - Paleta clara compartida entre canvas y DOM.
- Fuera:
  - Stakeholders externos, exportar/compartir, preferencias persistentes, métricas operacionales, notificaciones y mutaciones desde la UI.
  - Cambios al CLI, state schema o snapshot contract; derivación client-side sobre el snapshot actual.
  - Rediseñar Board, Overview, Gates, Knowledge, Activity o toda la shell.
  - Dark mode y un restyle global de tokens.

## Riesgos resueltos y decisiones de review

- **Lanes:** se adopta layout de aplicación rank × initiative; no se depende de compound support de `cytoscape-dagre`.
- **Focus path:** se divide en upstream blockers y downstream impact; no hay «critical path» sin datos de duración/prioridad.
- **Modos:** Execution, History y All relations son exclusivos; Context pertenece al inspector.
- **Rendimiento:** fixture/benchmark es trabajo previo con dueño; layout posterior se compara contra baseline y no se ejecuta por cambios no topológicos.
- **Detalle:** se reutiliza `NodeDetail`; sus cambios se serializan en una tarea propia para evitar conflicto.
- **Casos de producto:** Execution vacío conduce a History; una sola initiative minimiza el tratamiento de lanes; gates resueltas aparecen en History/inspector.

## ADRs derivados

- [ ] ADR-001: Modelo de vistas, selección y relaciones del Execution Map → `.adrs/001-graph-view-model.md`
  - Criterio: define view/focus state, visible sets, traversal y contrato client-side sin endpoints nuevos.
- [ ] ADR-002: Layout de lanes por initiative y presupuesto de rendimiento → `.adrs/002-graph-layout-and-performance.md`
  - Criterio: fija algoritmo rank × lane, baseline/umbral de 200 nodos y política de relayout.
- [ ] ADR-003: Nodos, semantic zoom, paleta light y contrato accesible → `.adrs/003-graph-node-and-accessibility.md`
  - Criterio: fija tiers visuales, mapa token→canvas, overlay accesible y fallback estrecho.
