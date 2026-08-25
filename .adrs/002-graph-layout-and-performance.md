# ADR-002: Layout de lanes por initiative y presupuesto de rendimiento

- Gate: `G-ui-graph-adr-002` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

`cytoscape-dagre` organiza un DAG LR pero no soporta compound nodes en el Graph actual. Por eso las initiatives terminaron como texto dentro de labels y no como estructura espacial. Graph 2.0 necesita lanes reales, cruces entre initiatives explicables y posiciones estables bajo polling.

Un proyecto observado llegó a 209 nodos, pero no existe fixture ni baseline reproducible. Antes de fijar la implementación, `T-ui-graph-benchmark` debe aportar un fixture determinista y una medición de referencia.

## Decisión propuesta

1. Mantener Cytoscape para renderer, hit testing, zoom, pan y edges.
2. Sustituir dagre como layout de Execution por un algoritmo puro y determinista de aplicación, aplicado mediante Cytoscape `preset`:
   - calcular ranks X por aristas `BLOCKS`;
   - asignar cada node a lane Y por `initiative`;
   - ordenar nodos de cada lane de manera estable, usando posición previa y vecinos para reducir cruces;
   - reservar rutas/espacio para edges cross-initiative;
   - contener ciclos y referencias incompletas sin fallar.
3. Las lanes son parte del layout, no compound nodes ni un fondo decorativo. En un proyecto de una sola initiative se minimizan/ocultan sus chrome.
4. Cross-initiative se deriva comparando initiatives de ambos endpoints; no se cambia el schema.
5. Calcular `topologyHash` con nodes/edges que afectan posiciones. Cambios de estado, claim, título, selección, filtro o foco actualizan estilo/conjunto visible sin correr layout cuando la topología y el conjunto posicionado no cambian.
6. Conservar `cytoscape-dagre` solo hasta completar la migración; ADR/implementación debe decidir su retiro si queda sin uso.

## Presupuesto y evidencia

La tarea `T-ui-graph-benchmark` deja:

- fixture de 200 nodos con múltiples initiatives, `BLOCKS`, history y relaciones cross-initiative;
- script reproducible que registra tiempos de construir elementos y ejecutar el layout base en varias corridas;
- hardware/runtime y resultados en la nota de la tarea.

La tarea de layout posterior debe:

- ejecutar layout sobre el fixture y no superar en más de 10% la baseline aprobada para el mismo entorno;
- demostrar que una actualización no topológica no invoca el layout;
- mantener pan/zoom y selección interactivos durante el fixture; la verificación visual/manual documenta navegador y viewport;
- declarar el comportamiento para 200+ nodos antes de introducir virtualización o worker.

## Consecuencias

- Se evita una nueva dependencia/adaptador sin probar para suplir compound nodes.
- El algoritmo es una responsabilidad explícita y testeable/purable, no una limitación oculta de un plugin.
- El equipo puede cambiar renderer sin perder el modelo espacial.

## Acceptance para la decisión

- Algoritmo rank × lane, entradas, salidas y fallback de ciclos están definidos.
- Las reglas de orden, estabilidad y cruces cross-initiative son verificables.
- Baseline, fixture, umbral y política de relayout quedan escritos tras `T-ui-graph-benchmark`.
- Declara la transición/eliminación de `cytoscape-dagre` si el preset layout lo reemplaza.

## Plan por piezas candidato

1. Fixture/benchmark independiente (`T-ui-graph-benchmark`).
2. Helper puro de layout y snapshot de posiciones.
3. Integración `preset` y lanes canvas/DOM.
4. Medición final e integración con modos/foco.
