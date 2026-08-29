# ADR-010: store reactivo, reconciliación y claves estables para UI live

- Gate: `G-ui-live-store-adr` · Deriva de: `G-ui-live-store-rfc` · Estado: aprobado
- Fecha: 2026-08-28

## Contexto

La RFC `G-ui-live-store-rfc` documenta que el polling de 2 segundos reemplaza el snapshot completo y que las vistas usan objetos nuevos como identidad de sus `<For>`. En Solid, esa combinación desmonta columnas y filas aun cuando el contenido semántico no cambió; en Board destruye el elemento que contiene `scrollTop`.

La UI debe continuar mostrando una proyección read-only del server, conservar su fachada de `useStore()` y preparar la proyección namespaced de plugins sin permitir código externo dentro del host.

## Decision

### 1. Store y slices

Se conserva `StoreProvider` como frontera pública y se reemplaza su snapshot monolítico interno por un store reactivo normalizado, implementado con `createStore` y reconciliación de `solid-js/store`.

El modelo canónico separa:

```text
transport: initialLoading, refreshing, errores, generated_at, lastSuccessfulAt y alerts del request
ui:        route, selectedId y estado efímero de navegación/detalle
entities:  nodes[id], initiatives, edges y plugins[pluginId]
views:     pools y colecciones renderizables con IDs/claves primitivas estables
```

`generated_at` no vive en la raíz de entities. Un snapshot nuevo actualiza transport y solo modifica una entity cuando cambió su contenido/revision. La ausencia de `plugins` se normaliza a `{}`; cada namespace de plugin sigue siendo opcional.

El server continúa siendo la fuente de verdad. No se agrega `fs.watch`, escritura desde el browser, ejecución de plugins durante GET ni ETag/304 como requisito de esta entrega.

### 2. Fachada compatible

La fachada mantiene las 14 keys actuales de `useStore()` sin renombrarlas ni eliminarlas:

```text
snapshot, error, loading, initialLoading, refreshing,
snapshotError, lastSuccessfulAt, route, setRoute, selectedId,
select, detail, detailError, reload
```

Se pueden agregar selectors estables. `snapshot()` y `detail()` se conservan como accesores de compatibilidad para consumidores existentes; el código migrado debe consumir slices/selectors y no usar el objeto completo como identidad de `<For>`.

El detail endpoint comparte la entidad base `nodes[id]` con el snapshot cuando trae un node conocido. Sus relaciones, history, refs, knowledge y payload específico permanecen en `details[id]`; no se mezclan en la entidad base ni provocan el reemplazo del node completo.

### 3. Identidad de colecciones

Toda colección renderizada con `<For>` debe tener una clave estable:

- Board: columnas por `ready`, `in_progress`, `blocked`, `backlog`; cards y gates por node ID.
- Nodes, Gates, Knowledge y NodeDetail: entidades por node ID.
- Activity: entries por `event_id` estable proveniente del log; el server puede agregarlo de forma aditiva usando el índice durable del evento.
- Overview y componentes compartidos: métricas, grupos, alerts y filas agregadas por claves deterministas, no por arrays u objetos creados durante cada poll.

Una modificación de contenido actualiza la vista sin remontar hermanos. Si una entidad cambia de colección, se elimina de la colección de origen y aparece en la de destino; ese remove/add es el único remontaje esperado.

### 4. Plugin boundary

Esta decisión solo fija el almacenamiento y la estabilidad del cliente. `G-plugin-ui-rfc` continúa siendo dueño del descriptor, validación, proyección server-side, slots y renderizadores declarativos. El store acepta sus datos namespaced sin interpretar HTML/JS ni ejecutar handlers. Un namespace ausente, plugin no instalado o error de descriptor no desmonta entidades core.

### 5. API y compatibilidad

No se cambia el schema v2 del CLI. El snapshot puede recibir campos aditivos namespaced para plugins. Los accesores legacy de `useStore()` se mantienen durante la migración completa; ninguna vista debe depender de que una referencia sea nueva para forzar un render.

## Consecuencias

- A favor:
  - polls sin cambios preservan identidad de entities y DOM;
  - `scrollTop`, `scrollLeft`, foco y selección no se pierden por reemplazos artificiales;
  - el polling, cancelación, fallback ante error y server read-only siguen en su lugar;
  - la fachada permite migrar vistas por etapas;
  - plugins futuros comparten una frontera namespaced y reactiva sin acoplarse al DAG core.
- En contra / deuda:
  - se introduce una capa de normalización y selectors que debe mantenerse alineada con el snapshot;
  - algunas colecciones sin ID natural requieren una convención estable de keys y posiblemente un campo aditivo `event_id`;
  - la fachada `snapshot()` puede conservar trabajo redundante hasta que todas las vistas migren;
  - la primera fase requiere serializar el trabajo sobre `store.jsx` y probar identidad DOM con el harness UI existente.

## Plan de implementación

1. **Bootstrap de ejecución** — archivos: `docs/plans/ui-live-store-execution.md`; mapear selectors, ownership, dependencias, colecciones sin ID, batches y pruebas. No implementa producto ni crea tasks hijas.
2. **Fundación del store** — owner de `ui/src/store.jsx` y nuevos helpers puros bajo `ui/src/store/`; conservar las 14 keys, aplicar reconciliación, separar transport/entities/UI/details y normalizar plugins. Tests de referencias, revisiones, errores y respuestas atrasadas.
3. **Board live** — owner de `ui/src/views/Board.jsx` y tests UI del Board; usar IDs estables y probar identidad de columnas/cards y persistencia de scroll.
4. **Listas operacionales** — owners separados para `ui/src/views/Nodes.jsx`, `Gates.jsx`, `Knowledge.jsx` y `Activity.jsx`; migrar entidades y entries a IDs/event keys estables.
5. **Overview, shell y detalle** — owner de `ui/src/views/Overview.jsx`, `ui/src/views/NodeDetail.jsx`, `ui/src/App.jsx` y cualquier `<For>` compartido en `ui/src/components.jsx`; migrar agregados, selección y cache base de detalle.
6. **Integración y contrato de plugins** — verificar snapshot aditivo, namespace ausente/error, build y compatibilidad con `G-plugin-ui-rfc`; no agrega renderizadores arbitrarios.

No se permite que dos workers editen `ui/src/store.jsx` en paralelo. Las tareas de vistas dependen de la fundación; las migraciones entre vistas pueden paralelizarse después del bootstrap cuando sus paths no se superpongan.

## Checkpoint de planificación post-ADR

- [ ] Sin bootstrap — no aplica: el ADR identifica varios módulos, contratos compartidos, colecciones sin keys naturales y una integración futura de plugins.
- [x] **Bootstrap** — creada `T-ui-live-store-bootstrap`, bloqueada por `G-ui-live-store-adr`. Su único entregable es `docs/plans/ui-live-store-execution.md`, con mapa de código, seams, ownership de paths, batches, dependencias, verificación y propuestas de tasks con acceptance. El bootstrap no implementa producto ni crea tasks hijas.

## Verificación

- Con el harness existente `npm run test:ui` y `UI_JSX_GENERATE=dom`, dos o más snapshots semánticamente idénticos conservan `beforeColumn === afterColumn` y `beforeCard === afterCard`.
- Tras tres polls idénticos, una columna con `scrollTop = 240` y el contenedor Board con `scrollLeft = 180` conservan esos valores dentro de sus límites.
- Un cambio de título/claim actualiza la card correcta y conserva la identidad DOM de sus hermanas; un cambio de status mueve la card una sola vez.
- `useStore()` conserva las 14 keys; `generated_at` distinto no invalida entities y `plugins` ausente se expone como `{}`.
- NodeDetail mantiene selección, node base y estado de navegación mientras se actualizan por separado relaciones/history/refs.
- Activity, alerts, métricas y grupos usan keys estables y no pierden expansión/foco por un poll sin cambios.
- Respuestas atrasadas, aborts y errores conservan el último snapshot válido.
- `npm run test:ui`, `npm test`, `npm --prefix ui run build` y `git diff --check` pasan.
