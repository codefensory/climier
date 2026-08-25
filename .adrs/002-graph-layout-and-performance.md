# ADR-002: Layout de lanes por initiative y presupuesto de rendimiento

- Gate: `G-ui-graph-adr-002` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

`cytoscape-dagre` organiza un DAG LR, pero no soporta compound nodes y no produce lanes reales por initiative. Graph 2.0 necesita estructura espacial estable bajo polling, cruces entre initiatives explicables y un contrato que no mezcle coste de helpers con coste de renderer.

Se completaron dos baselines sobre el fixture versionado de 200 nodos (`RUNS=20`, `WARMUP=3`, Node 26.7.0 en el host de validación):

| Perfil | Qué mide | p95 observado |
|---|---|---:|
| `helper_pure` | `toCytoscapeElements` + `computeLayout`, sin Cytoscape/DOM | 0.285 ms layout |
| `cytoscape_dagre_headless` | instancia Cytoscape headless + `cy.layout({ name: "dagre" })` | 74.63 ms layout |

El segundo perfil mide el layout actual real, pero no canvas, overlay DOM, pan/zoom, FPS ni gestos. Ambos perfiles siguen siendo útiles y no son intercambiables.

La política aprobada para Graph 2.0 es no crear ni modificar archivos bajo `test/`; las verificaciones de layout viven en el benchmark versionado y build/manual documentado.

## Decisión

### Algoritmo y contrato puro

Execution usa `computeExecutionLayout(nodes, edges, options)` nuevo y puro. Cytoscape conserva renderer, hit testing, zoom/pan y edges, pero aplica las posiciones resultantes con `preset`; dagre deja de decidir la geometría de Execution.

Entrada:

```js
{
  nodes, edges,
  previousPositionsById: Record<string, { x, y }> | undefined,
  visibleIds: Set<string>,
}
```

Salida:

```js
{
  positions: Record<string, { x, y }>,
  lanes: [{ initiative, y, height, nodeIds }],
  topologyHash: string,
  positionedSetHash: string,
  diagnostics: { cycles: string[][], missingEndpoints: string[] },
}
```

- Solo `BLOCKS` afecta rank X. `SUPERSEDES`, `DERIVED_FROM` y legacy no alteran posiciones.
- Cada initiative forma una lane Y. El nombre es `node.initiative || "(none)"`; lanes se ordenan alfabéticamente con `(none)` al final, igual que el selector de initiatives.
- La coordenada X es rank de `BLOCKS`; Y es lane. Dentro de un rank/lane se conserva el orden de `previousPositionsById`; sin posición previa, desempata por ID léxico. No se ejecuta un minimizador no acotado de cruces.
- Los SCC se calculan de forma determinista. Todos los miembros de un SCC comparten `rank = 1 + max(rank de bloqueadores externos)`; si no tienen bloqueadores externos, rank 0. Su orden interno es léxico. Edges internos se conservan como backedges visibles. Endpoints inexistentes se excluyen del cálculo, se listan en diagnostics y no hacen fallar el layout.
- Lane única: se calcula pero se oculta su chrome visual; la geometría no desperdicia una banda adicional.

### Cruces entre initiatives

v1 no implementa channel routing ni bend points por edge. Reserva un gutter fijo de 48 px entre lanes y deja que Cytoscape trace bezier/edge existente. El bridge visual de un edge cross-initiative se activa al foco/selección según ADR-001. Así la geometría es determinista y no se intenta optimizar cada cruce de forma costosa.

### Hash, actualizaciones y relayout

- `topologyHash` contiene IDs visibles, initiative normalizada y aristas `BLOCKS` visibles ordenadas.
- `positionedSetHash` contiene IDs y edges que realmente reciben posiciones.
- Título, status, claim, selección y foco pertenecen a un `styleHash`/estado visual y nunca cambian `topologyHash`.
- Cambiar modo/filtro relayout solo si cambia `positionedSetHash`; cambiar un dato no topológico actualiza elementos/clases en lote y conserva posiciones.
- `computeLayout` actual coexiste sin cambios para compatibilidad. `computeExecutionLayout` es el único layout de Execution una vez integrado.

### Presupuestos y verificación

El benchmark mantiene dos perfiles. Para el fixture de 200 nodos y `RUNS=20/WARMUP=3`:

1. `computeExecutionLayout` debe producir p95 ≤ **5 ms** en el perfil puro.
2. La aplicación headless de elementos + posiciones `preset` debe producir p95 ≤ **82 ms**, comparable con el baseline dagre de 74.63 ms y con margen absoluto de 7.37 ms.
3. El benchmark añade un escenario `snapshot N → N+1` con cambio solo de título/status/claim y registra que la política de layout no invoca una segunda ejecución.
4. La tarea de integración documenta revisión manual en navegador y viewport para canvas, overlay y gestos; no presenta la métrica headless como FPS.

## Consecuencias

- El modelo de lanes no depende de compound support de una extensión.
- El layout es inspectable, determinista y reutilizable si cambia el renderer; Cytoscape queda como renderer v1.
- Los dos benchmarks evitan comparar métricas incompatibles.
- `cytoscape-dagre` se elimina solo en una tarea posterior, una vez que ningún Graph path lo importe.

## Acceptance para la decisión

- Firma, salida, SCCs, endpoints faltantes, lane vacía y orden estable están definidos.
- Cross-initiative usa gutter fijo y bezier; no hay channel routing implícito.
- Hashes y condiciones exactas de relayout están definidos.
- Baselines, métricas, runs/warmup y umbrales son comparables.
- No se tocan `test/`; el benchmark y build son la evidencia automatizable.

## Plan por piezas candidato

1. **Helper de layout:** `computeExecutionLayout` + diagnostics, coexistiendo con `computeLayout`; sin tocar renderer.
2. **Benchmark de política:** extiende `ui/scripts/benchmark-graph.mjs` con preset y escenario no-topológico; depende de 1.
3. **Integración Execution:** `Graph.jsx` consume preset/lanes y separa topology/style hashes; depende de 1–2 y ADR-001.
4. **Retiro dagre:** quita `cytoscape-dagre` de `ui/package.json`, lock y Graph solo tras 3; tarea exclusiva de esas rutas.
