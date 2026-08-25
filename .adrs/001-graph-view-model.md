# ADR-001: Modelo de vistas, selección y relaciones del Execution Map

- Gate: `G-ui-graph-adr-001` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

El Graph actual mezcla filtros persistentes de formulario, historia y foco de vecinos. Graph 2.0 necesita separar qué conjunto de nodos responde a una intención operacional de cómo se busca dentro de ese conjunto y cómo se enfoca un camino, sin cambiar el snapshot ni crear endpoints.

`ui/src/store.jsx` hoy conserva `selectedId` y polling; `ui/src/views/NodeDetail.jsx` ya contiene detalle de blockers, dependents, decisiones y knowledge. El modelo nuevo debe aprovechar ambos y no duplicar el drawer.

## Decisión propuesta

1. Mantener un único modo exclusivo: `execution`, `history` o `all`.
2. Derivar los conjuntos en cliente desde `snapshot.nodes`, `snapshot.edges` y los estados ya presentes. No se agregan campos al state ni endpoints.
3. Aplicar búsqueda, initiative, tipo y estado **después** de derivar el conjunto base del modo.
4. Reemplazar el acoplamiento implícito de `filterGraph()` por selectores puros con contrato explícito:
   - `visibleSetForMode(snapshot, mode)`;
   - `applyGraphFilters(visibleSet, filters)`;
   - `upstreamBlockers(edges, id)`;
   - `downstreamImpact(edges, id)`;
   - `crossInitiativeEdges(nodes, edges)`.
5. Definir foco como estado independiente de selección:
   ```js
   graphView: {
     mode: "execution" | "history" | "all",
     focus: null | { kind: "upstream" | "downstream" | "initiative", id: string },
   }
   ```
   No se persiste entre sesiones. Seleccionar un nodo no fuerza foco; las acciones de foco sí actualizan la cámara y el conjunto resaltado.
6. Upstream y downstream atraviesan todos los `BLOCKS` alcanzables mediante BFS, con `visited` para ciclos. No existe acción llamada “critical path”, porque Climier no almacena duración ni prioridad.
7. Reutilizar `NodeDetail` como inspector. Esta ADR solo define qué contexto Graph le pasa o enlaza; una tarea posterior serializa cualquier edición de `NodeDetail.jsx`.

## Consecuencias

- Execution puede ser simple y priorizado; History y All son elecciones deliberadas.
- Decision/knowledge se consultan en el drawer y no fuerzan un cuarto modo.
- El cambio permite probar los selectores sin DOM y mantiene el servidor/read-only sin cambios.
- Las vistas Board/Nodes no cambian durante esta fase.

## Acceptance para la decisión

- La ADR identifica el shape final del estado Graph y su relación con `selectedId`.
- Define inclusion/exclusion por modo, incluyendo nodes cerrados, gates y knowledge.
- Define orden de evaluación de modo, filtros, búsqueda y foco.
- Define comportamiento ante ciclos, endpoints faltantes, proyecto sin trabajo activo y una única initiative.
- Confirma explícitamente derivación client-side y cero endpoints/schema nuevos.

## Plan por piezas candidato

1. Selector/state de Graph (sin cambiar renderer).
2. Controles de modo, foco y cámara.
3. Integración contextual con NodeDetail, serializada respecto de su propio track.
