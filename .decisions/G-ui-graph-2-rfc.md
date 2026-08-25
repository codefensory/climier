# RFC: Graph 2.0 — Execution Map light

- Gate: `G-ui-graph-2-rfc` · Iniciativa: `ui` · Estado: en review
- Autor: orchestrator, con dirección del usuario · Fecha: 2026-08-25

## Problema

La vista `ui/src/views/Graph.jsx` ya migró de SVG nativo a Cytoscape con layout dagre LR, zoom/pan, filtros y un overlay accesible de botones. Esa migración resolvió el renderer, pero no el producto: conserva el lenguaje del grafo anterior y presenta una topología plana donde todos los nodos y relaciones compiten por atención.

El modelo de Climier no es un grafo homogéneo. `BLOCKS` expresa ejecución y disponibilidad; `SUPERSEDES` expresa reemplazo histórico; `DERIVED_FROM` expresa procedencia; knowledge y relaciones legacy aportan contexto. En la implementación actual estas relaciones comparten el mismo canvas, los grupos por initiative se reducen a texto dentro del label porque `cytoscape-dagre` no soporta compound nodes, y la selección solo ilumina vecinos directos. El resultado no responde con prioridad: «¿qué trabajo avanza, qué lo bloquea y qué contexto necesito para desbloquearlo?».

La UI sigue siendo una proyección local y read-only del snapshot del CLI. El snapshot se refresca cada 2 s y la vista debe funcionar con proyectos del orden de 200 nodos (la observación histórica documentada llega a 209) sin relayout ni reconstrucción innecesarios.

## Propuesta

Rediseñar Graph como un **Execution Map light**: un espacio operacional para entender y navegar trabajo registrado, no una visualización exhaustiva de cada edge por defecto.

La dirección visual queda fijada por el usuario: **light mode**, con superficies claras, contraste tipográfico alto, color semántico moderado y sin depender de un canvas oscuro para crear jerarquía. «Premium» significa claridad, ritmo espacial, interacción predecible y densidad controlada; no glassmorphism, decoración ni un arcoíris de edges.

### Preguntas que debe responder

1. ¿Qué se puede ejecutar ahora y qué está impidiendo avanzar?
2. ¿Cuál es la cadena de bloqueo o impacto de un task/gate?
3. ¿Qué decisión o knowledge explica ese trabajo?
4. ¿Cómo se coordina el trabajo entre initiatives?
5. ¿Qué parte es historia y no debe distraer de la ejecución actual?

### Modelo de vistas

La vista no parte de «mostrar todo». Ofrece modos con intención explícita:

- **Execution (default):** tasks activas, gates abiertas y los `BLOCKS` necesarios para explicar disponibilidad. Nodos cerrados y knowledge periférico se omiten o se retraen.
- **Decision & context:** gates, knowledge y relaciones `DERIVED_FROM` / informativas que explican el porqué de una pieza de trabajo.
- **History:** cadenas `SUPERSEDES`, nodos cerrados, deprecated y procedencia histórica.
- **All relations (advanced):** auditoría explícita; nunca default.

Los filtros dejan de ser el mecanismo principal de comprensión. Búsqueda, initiative, estado, tipo y toggles de relaciones complementan el modo activo desde una barra de comando y un panel de filtros progresivo.

### Gramática espacial y de relaciones

- El layout de **Execution** usa `BLOCKS` como estructura: el edge canónico `from BLOCKS to` debe leerse sin ambigüedad como «from bloquea a to».
- Las initiatives son regiones/lanes de coordinación, no un chip repetido en cada card. Los cruces entre initiatives son información relevante y deben poder enfocarse.
- El estado no reordena el flujo; cambia la presencia visual. Trabajo blocked, ready e in-progress domina. Done/resolved/deprecated se retraen salvo que el modo los solicite.
- `BLOCKS` es sólido, direccional y dominante. `SUPERSEDES` solo aparece en History o al enfocar. `DERIVED_FROM` e informativas pertenecen a Context o selección. Labels de edges aparecen en foco/hover, no como ruido permanente.
- Ciclos, endpoints inexistentes y nodos sin relaciones deben seguir visibles y explicables, sin asumir que el DAG sea perfecto.

### Nodos, detalle y navegación

Los tipos siguen siendo los conceptos canónicos de Climier, pero su presentación responde a su rol:

- **Task:** card de trabajo con título, estado derivado/persistido, initiative y señal de claim o bloqueo relevante.
- **Gate:** card de decisión/aprobación/investigación con propósito e impacto downstream.
- **Knowledge:** contexto compacto, claramente secundario a ejecución pero recuperable desde Context y selección.

El zoom es semántico:

| Nivel | Representación |
|---|---|
| Cercano | Card completa y metadatos operacionales relevantes. |
| Medio | ID, título y estado/rol. |
| Lejano | Marker/glyph agrupado; labels selectivos, nunca texto ilegible. |

Seleccionar abre o actualiza el inspector `NodeDetail`, con una primera respuesta de «por qué está así», ruta de blockers/dependents, decisiones y knowledge aplicable. La acción **Focus path** muestra camino relevante, no solo vecinos. **Focus initiative** aísla una initiative sin esconder cruces externos necesarios. Búsqueda lleva la cámara al resultado y conserva navegación por teclado.

### Accesibilidad

Cytoscape canvas no expone nodos semánticos al DOM. La implementación debe mantener una capa DOM accesible sincronizada con el grafo: foco visible, nombre accesible, teclado, selección, Escape y una alternativa de navegación para usuarios que no puedan operar un canvas. La capa no puede degradar pan/zoom ni rendimiento.

### Rendimiento y robustez

- Normalizar una vez por snapshot: índices de adjacency, tipos de relación, estados visibles y rutas de foco.
- Recalcular layout solo si cambia topología o la vista/modo lo requiere; no por cada poll, cambio de claim o label.
- Conservar posiciones por firma de topología y aplicar actualizaciones de estilo en lote.
- Usar culling/semantic zoom para cards y labels. Una capa DOM rica no debe mantener trabajo de layout por todos los nodos cuando están fuera de viewport o por debajo del umbral de zoom.
- Definir presupuesto verificable antes de implementación: interacción de pan/zoom fluida y selección inmediata en un fixture de al menos 200 nodos; degradación controlada antes de introducir virtualización o workers.
- El snapshot, el CLI, las reglas DAG y el carácter read-only no cambian.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| A. Retocar el Graph actual (estilos, colores y más filtros sobre dagre plano) | Menor cambio y aprovecha el renderer recién migrado. | No resuelve la jerarquía de relaciones, la intención de navegación, lanes por initiative ni la densidad; sería otro restyle. |
| B. Execution Map light con modos semánticos, lanes, semantic zoom e inspector integrado — **recomendada** | Alinea la visualización con el modelo de Climier; hace que `BLOCKS` sea operacional y el contexto sea recuperable sin ruido; permite escalar la experiencia. | Requiere decidir layout/agrupación, redefinir interacción y dividir la implementación en varias tareas. |
| C. Sustituir Graph por tablas/board y dejar una vista de relaciones mínima | Más simple y accesible. | Pierde la navegación espacial de coordinación y hace difícil entender cruces entre initiatives y caminos de bloqueo. |

## Alcance

- Dentro:
  - Redefinir propósito, modos, jerarquía de relaciones, arquitectura de información e interacción de `Graph`.
  - Light mode para la experiencia del Graph y su integración con los tokens existentes.
  - Estrategia de layout que soporte la estructura de initiatives o una alternativa equivalente que no convierta la initiative en mero texto.
  - Semantic zoom, path focus, búsqueda/navegación, inspector integrado, accesibilidad y presupuesto de rendimiento.
  - Mantener Cytoscape como candidato a renderer; evaluar si dagre sigue siendo suficiente para layout.
- Fuera:
  - Mutaciones desde la UI o cambios al CLI/state schema/snapshot contract salvo que un ADR justifique un campo estrictamente necesario.
  - Rediseñar Board, Overview, Gates, Knowledge, Activity o toda la shell en este RFC.
  - Dark mode como dirección principal.
  - Implementación directa antes de resolver decisiones derivadas.

## Riesgos y open questions

- **`cytoscape-dagre` no soporta compound nodes** (hecho confirmado en la migración actual) → investigar layout alternativo con agrupación jerárquica/lanes, o definir lanes de aplicación sin falsear el layout.
- **Cards DOM + canvas** pueden afectar pan, foco y performance → prototipo con semantic zoom, viewport culling y presupuesto medible antes de fijar la técnica.
- **Todos los edges visibles** puede volver ilegible el mapa → cada modo debe declarar qué relaciones muestra y qué revela bajo demanda.
- **Mobile y pantalla estrecha** → no intentar reproducir el canvas desktop; definir navegación centrada en búsqueda, foco y detalle.
- **Escala real futura** → validar el presupuesto inicial con 200 nodos y decidir umbral para clustering/virtualización o layout en worker.
- **Semántica de «ruta relevante»** → decidir si Focus path recorre todos los `BLOCKS`, solo la ruta crítica, o permite ambas opciones.
- **Lanes por initiative** → decidir si son obligatorios en Execution o si la initiative se resuelve mejor con focus/agrupación bajo demanda.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-001: Modelo de vistas y semántica de relaciones del Execution Map → `.adrs/001-graph-view-model.md`
- [ ] ADR-002: Estrategia de layout, lanes por initiative y rendimiento → `.adrs/002-graph-layout-and-performance.md`
- [ ] ADR-003: Representación de nodos, semantic zoom y contrato accesible → `.adrs/003-graph-node-and-accessibility.md`
