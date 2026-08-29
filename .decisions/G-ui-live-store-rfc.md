# RFC: store reactivo y reconciliación de snapshots para la UI

- Gate: `G-ui-live-store-rfc` · Iniciativa: `ui` · Estado: aprobado
- Autor: orchestrator, con dirección del usuario · Fecha: 2026-08-28

## Problema

La UI recibe un snapshot nuevo cada 2 segundos desde `/api/snapshot`. `StoreProvider` reemplaza el snapshot completo con `setSnapshot(snap)`, aunque el estado del proyecto no haya cambiado; además, el server incluye un `generated_at` nuevo en cada respuesta. Esto crea referencias nuevas para nodes, arrays y objetos derivados.

Las vistas usan `<For>` con objetos recién creados como items. En particular, `Board.jsx` recrea `columns()` y sus cards en cada poll, por lo que Solid desmonta y vuelve a montar columnas completas. El elemento que posee `scrollTop` desaparece y el scroll interno vuelve al inicio. El mismo patrón existe en distintos grados en `Nodes.jsx` (ruta Tasks), `Gates.jsx`, `Knowledge.jsx`, `Overview.jsx` y otras listas.

La UI necesita seguir siendo una proyección read-only y actualizada, pero un refresh sin cambios no debe destruir identidad DOM, foco, selección ni posición de scroll.

## Propuesta

Introducir una capa de store reactivo normalizado detrás del `StoreProvider` existente, sin cambiar la API pública de `useStore()` de las vistas en la primera fase.

El store separa cuatro responsabilidades:

```text
transport: polling, aborts, errores, refreshing y lastSuccessfulAt
ui:        route, selectedId y estado efímero de detalle
entities:  nodes[id], initiatives, edges y datos namespaced de plugins
views:     pools derivados y listas de IDs estables para Board y otras vistas
```

La ingesta de cada snapshot reconcilia entidades por ID/revision y conserva la identidad de las entidades que no cambiaron. Las colecciones que alimentan renderizados se exponen como IDs o claves primitivas estables. Los componentes leen la entidad actual por ID, en vez de recibir el objeto completo como identidad de `<For>`.

La implementación recomendada usa `createStore` y la reconciliación disponible en `solid-js/store`, que ya forma parte del subproyecto `ui/`; no agrega una dependencia al paquete CLI raíz. El contexto actual continúa siendo la frontera consumida por las vistas.

La fachada conserva explícitamente las keys actuales de `useStore()`: `snapshot`, `error`, `loading`, `initialLoading`, `refreshing`, `snapshotError`, `lastSuccessfulAt`, `route`, `setRoute`, `selectedId`, `select`, `detail`, `detailError` y `reload`. Puede agregar selectors estables, pero la primera migración no elimina ni renombra esas keys. `snapshot()` queda como compatibilidad; las vistas migradas no deben usar el objeto snapshot completo como identidad de una colección.

La raíz reactiva no mezcla dominio y transporte. `generated_at`, `refreshing`, errores y alerts temporales viven en metadata/transport; nodes, iniciativas, edges, pools y datos de plugins viven en slices reconciliables. Las colecciones renderizables —incluidos `recent_activity`, grupos de alerts y cualquier lista agregada— deben exponer IDs o una clave determinista y estable, aunque el item no sea una entidad core.

Un poll sin cambios puede actualizar metadatos de transporte y timestamps sin invalidar innecesariamente las entidades. No se reemplaza el polling por `fs.watch`, cache del state file ni ejecución de plugins durante requests. El server sigue releyendo el state file por request, tal como establece `K-ui-live-state`.

### Contrato para plugins

El store reserva un espacio namespaced para datos ya proyectados por el server, por ejemplo `plugins[pluginId]`. La fachada normaliza la ausencia de `plugins` a un mapa vacío para mantener un shape estable, pero no decide todavía el descriptor final: cada namespace es opcional y no se confunde con entidades core. No ejecuta código frontend arbitrario ni handlers de plugins. La RFC existente `G-plugin-ui-rfc` continúa definiendo descriptors, validación y renderizadores; esta RFC define la estabilidad y distribución de esos datos dentro del cliente.

Los plugins consumen selectors o props de sus slots declarativos y no mutan directamente el snapshot core. Un plugin ausente o con error conserva el aislamiento del resto del store y no desmonta la UI principal. El cache compartido con `NodeDetail` usa la entidad base `nodes[id]` cuando el snapshot la conoce; la respuesta de detalle mantiene aparte sus relaciones, history, refs y payload específico, pero actualiza la misma entidad base por ID.

### Compatibilidad

- El snapshot actual del server sigue siendo la fuente de verdad.
- Los campos core actuales de `/api/snapshot` y `/api/node/:id` se preservan.
- Las contribuciones de plugins siguen siendo aditivas y namespaced.
- Las 14 keys actuales de `useStore()` se conservan con semántica compatible; los selectors nuevos son aditivos.
- `StoreProvider`, selección, polling, aborts y fallback ante errores conservan su comportamiento observable.
- No se cambia el schema v2 del CLI ni se escribe estado desde el navegador.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| A. Solo cambiar Board para iterar IDs estables | Fix pequeño y rápido para el síntoma principal | Deja el mismo problema en `Nodes.jsx`, `Gates.jsx`, `Knowledge.jsx` y futuras vistas de plugins; no resuelve la frontera de estado compartida |
| B. Store normalizado con reconciliación, IDs estables y fachada compatible — **recomendada** | Conserva identidad, permite actualizar solo lo que cambió, prepara plugins y mantiene el contexto actual | Requiere diseñar slices, selectors, ingestión y pruebas de identidad |
| C. Librería externa de queries/cache o reemplazo completo del estado | Puede ofrecer deduplicación y cache listos | Agrega complejidad y dependencia; no resuelve por sí misma las claves de `<For>` ni el contrato de plugins |
| D. ETag/304 o comparar snapshots en el server | Reduce payload y señales cuando no hay cambios | Es optimización de transporte, no corrige el remontaje cuando sí llega un snapshot nuevo; no reemplaza claves estables |

## Alcance

- Dentro:
  - modelo interno normalizado detrás de `StoreProvider`;
  - reconciliación de snapshots y preservación de identidad por node ID/revision;
  - listas renderizadas con IDs/claves estables;
  - corrección del Board y migración de listas afectadas de `Nodes.jsx` (ruta Tasks), `Gates.jsx`, `Knowledge.jsx`, `Overview.jsx` y las listas compartidas que correspondan;
  - separación entre datos de dominio, estado de transporte y estado efímero de UI;
  - matriz explícita de ownership para `store.jsx`, `App.jsx`, `components.jsx` y cada vista migrada;
  - espacio namespaced para la futura proyección read-only de plugins;
  - regresiones de DOM identity, `scrollTop`, `scrollLeft`, foco, selección y cambios reales;
  - preservación de cancelación, respuesta atrasada y fallback ante error.
- Fuera:
  - mutaciones desde la UI;
  - reemplazar el server como fuente de verdad;
  - `fs.watch` sobre `tasks.json`;
  - ejecutar código de plugins en browser o server durante un GET;
  - UI arbitraria, HTML/CSS/JS de plugins o nuevas rutas de plugin;
  - cambiar el schema v2 o introducir dependencias runtime en el CLI raíz;
  - prometer 304/ETag como requisito de la primera implementación.

## Riesgos y open questions

- `createStore` y la reconciliación pueden conservar referencias de forma distinta para arrays, mapas y objetos anidados → fijar pruebas de identidad para entities y colecciones antes de migrar vistas.
- Un node puede cambiar de columna → la lista de origen debe perderlo y la de destino recibirlo; las entidades no cambiadas dentro de cada lista deben conservar DOM.
- Los alerts de stale claims y `generated_at` cambian por el paso del tiempo aunque el state no cambie → mantenerlos en transporte/metadata y no tratarlos como cambio de entidad.
- La migración de todas las vistas puede crecer de alcance → implementar primero la fachada y Board, luego migrar listas con una matriz explícita de ownership y dependencias.
- El detalle abierto usa un endpoint separado y también se refresca → conservar su ciclo de abort/reemplazo; compartir solo `nodes[id]` con el snapshot y mantener relaciones/history como payload de detalle separado.
- Los datos de plugins pueden llegar o desaparecer entre polls → normalizar `plugins` ausente a `{}` y mantener cada namespace opcional, sin borrar ni remontar contenido core innecesariamente.
- Las listas agregadas no siempre tienen una entidad natural → definir claves deterministas para activity, alerts agrupadas, métricas y cualquier colección que use `<For>`.
- El harness de UI ya existe en `test/ui-*.test.mjs`, con `UI_JSX_GENERATE=dom` para pruebas DOM; `npm test` excluye esos archivos y `npm run test:ui` es el comando explícito para ejecutarlos.
- La RFC de `plugin-ui` está abierta → el ADR de esta RFC debe ser requisito técnico del contrato client-side de plugins, sin resolver todavía el descriptor ni el packaging.

## Verificación propuesta

- Dos snapshots semánticamente idénticos mantienen el mismo elemento DOM de la columna y de la card `T-x`; un assert verifica `beforeCard === afterCard`.
- Tras tres polls idénticos, un `columnBody.scrollTop = 240` y un `board.scrollLeft = 180` conservan esos valores dentro del límite del contenido.
- Un cambio de título, claim o status actualiza la card correcta sin remontar las demás; un assert conserva la referencia DOM de una card hermana.
- Mover una task de una columna a otra produce exactamente un remove/add esperado y no duplica IDs.
- `useStore()` conserva las 14 keys documentadas, `generated_at` distinto no reemplaza entities y el namespace plugin ausente se normaliza a `{}`.
- La selección y el NodeDetail abierto sobreviven a refreshes y respetan aborts; el node base conserva su identidad cuando solo cambia el payload de relaciones.
- Errores y respuestas atrasadas no reemplazan el último snapshot válido.
- Datos de plugin namespaced se agregan, actualizan y eliminan sin afectar entidades core.
- `npm --prefix ui run build`, `npm run test:ui` y `npm test` pasan.

## ADRs derivados (se completa al aprobar)

- [x] ADR-010: store reactivo, reconciliación y claves estables para UI live → `.adrs/010-ui-live-store.md`
- [ ] ADR-011: integración del store con proyección read-only de plugins → `.adrs/011-plugin-ui-store-boundary.md`
