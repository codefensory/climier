# ADR-001: Modelo de vistas, selección y relaciones del Execution Map

- Gate: `G-ui-graph-adr-001` · Deriva de: `G-ui-graph-2-rfc`
- Estado: propuesto · Fecha: 2026-08-25

## Contexto

Graph 2.0 necesita separar qué conjunto de nodos responde a una intención operacional de cómo el usuario busca dentro de ese conjunto y cómo enfoca una relación. El estado debe sobrevivir la navegación interna de la UI, sin persistirse entre sesiones ni cambiar el snapshot, el schema o endpoints.

`selectedId` vive en `StoreProvider` y `NodeDetail` ya explica blockers, dependents, decisiones y knowledge. El nuevo modelo reutiliza ese drawer. La política aprobada por el usuario para Graph 2.0 es **A: no crear ni modificar archivos bajo `test/`**; se preservan los helpers y tests existentes sin cambios.

## Decisión

### Estado y ciclo de vida

`StoreProvider` incorpora `graphView` como estado de memoria de la sesión:

```js
graphView: {
  mode: "execution" | "history" | "all",
  focus: null | { kind: "upstream" | "downstream" | "initiative", id: string },
}
```

No se serializa a URL, localStorage ni servidor. Sobrevive al cambio de rutas mientras vive `StoreProvider`. `selectedId` sigue siendo el único nodo seleccionado. Al seleccionar un nodo nuevo, cualquier foco anterior se reemplaza; no hay highlights acumulables de nodos distintos.

En Execution, seleccionar un task/gate derivadamente blocked activa automáticamente `focus: { kind: "upstream", id }`. En los demás casos selecciona sin foco; el usuario puede activar Upstream blockers, Downstream impact o Focus initiative. El foco siempre tiene como objetivo el nodo seleccionado.

### Modos y conjuntos base

Los modos son exclusivos y se derivan en cliente desde el snapshot actual:

- **Execution:** resolvables no terminales y sus relaciones `BLOCKS`; oculta `done`, `canceled`, `resolved`, `superseded` y `deprecated`. Knowledge solo aparece si tiene una relación visible con ese conjunto. Si no queda trabajo activo, no muestra un canvas vacío: ofrece transición explícita a History.
- **History:** solo endpoints presentes de `SUPERSEDES` o `DERIVED_FROM`, y edges de esos tipos entre dichos endpoints. No mezcla el fondo Execution ni añade `BLOCKS` ajenos; un gate resolved sin relación de historia sigue accesible desde NodeDetail/Finder, no se inventa como cadena histórica.
- **All:** todos los nodos y todos los edges existentes, incluidos knowledge aislado y relaciones legacy. Es auditoría avanzada, no bloquea el valor de Execution.

Execution usa el conjunto operacional existente, no solo tasks claimable: incluye ready, blocked, in-progress, backlog y gates abiertas según los pools/derivación ya expuestos por el snapshot. La presentación del estado usa los valores derivados del snapshot cuando existan; el modo no reimplementa semántica DAG del CLI.

### Pipeline de selección

El orden es fijo:

```text
snapshot
  → visibleSetForMode(mode)
  → applyGraphFilters(initiative, kind, status)
  → applyGraphSearch(query)
  → layout si cambia el conjunto posicionado
  → focus (solo resaltado/atenuación; nunca filtra)
```

Cambiar modo o filtros es layout-affecting solo cuando cambia el conjunto posicionado de IDs/edges `BLOCKS`. Cambiar selección, foco, título, claim o estado es una actualización visual y no debe relayout el conjunto existente.

`filterGraph` queda intacto como helper de compatibilidad para los consumidores y tests actuales. Los selectores nuevos viven junto a él y el renderer nuevo los adopta gradualmente; una limpieza posterior podrá deprecarlo, nunca dentro de Graph 2.0 v1.

### Relaciones y cruces entre initiatives

`upstreamBlockers` y `downstreamImpact` hacen BFS por todos los `BLOCKS` alcanzables, con `visited` para ciclos y sin prometer una critical path inexistente. `crossInitiativeEdges` compara `node.initiative` en ambos endpoints; no modifica el schema.

Un edge cross-initiative conserva el color/semántica de su tipo. En Execution se distingue por clase `cross-initiative`, mayor grosor y un bridge/label en el cruce de lane cuando está seleccionado o enfocado; nunca por color solamente. ADR-002 decide su geometría, no su significado.

### Controles y detalle

El selector de modo es un segmented control accesible: botones con `aria-pressed`, `aria-label`, foco visible y navegación con flechas izquierda/derecha entre opciones. Finder sigue siendo la vía global de encontrar cualquier node; seleccionar un resultado lleva la cámara al nodo si pertenece al modo actual o explica el cambio de modo necesario.

`NodeDetail` se reutiliza. Una tarea propia, después del estado/selectores, puede añadir controles o resumen de foco sin duplicar el drawer.

## Consecuencias

- Execution mantiene una respuesta operacional inmediata; History y All son elecciones deliberadas.
- La state machine de Graph queda en el store, no se resetea al navegar por la UI.
- Los selectores y modelo espacial permanecen independientes del renderer; Cytoscape sigue siendo el renderer comprometido para v1.
- No se crean ni cambian tests. La verificación es build, benchmark, navegación manual y preservación de los archivos de test existentes.

## Acceptance para la decisión

- El shape de `graphView`, su ciclo de vida y relación con `selectedId` están definidos.
- Cada modo define IDs/edges incluidos, incluyendo Execution vacío, History y knowledge.
- Orden de modo, filtros, búsqueda, layout y foco está fijado.
- Focus upstream/downstream, ciclos, cruces entre initiatives y selección no acumulable están definidos.
- No se agregan endpoints, campos de schema, persistencia ni cambios en `test/`.

## Plan por piezas candidato

1. **Modelo puro:** selectores nuevos en `graph-helpers.mjs` o módulo vecino; conserva `filterGraph` sin modificar tests.
2. **Store:** agrega `graphView` a `store.jsx`, sin tocar Graph/NodeDetail.
3. **Controles Graph:** modos, pipeline y foco en `Graph.jsx`; depende de 1–2.
4. **Detalle de foco:** cambio aislado de `NodeDetail.jsx`; depende de 1–2 y no comparte worktree con 3.
