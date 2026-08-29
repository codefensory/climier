# Plan de ejecución: store reactivo y reconciliación de snapshots (ADR-010)

Plan derivado de la inspección real del repo contra `.adrs/010-ui-live-store.md`
(`G-ui-live-store-adr` resuelto). Convierte el contrato del ADR en el DAG más
pequeño que permita paralelismo real sin solapamiento, fija la fachada
`useStore()` (14 keys), seams entre store/transport/entities/views/details,
ownership exclusivo de paths, batches paralelos, comandos de verificación
con asserts de identidad/scroll, y riesgos que invalidarían el orden.

## 1. Punto de partida observado

Inspección del repo en `main` (HEAD `249014b ui: speed up drawer motion`).

- `ui/src/store.jsx` (146 líneas) es un provider monolítico con 12
  `createSignal` independientes: `snapshot`, `initialLoading`, `refreshing`,
  `snapshotError`, `lastSuccessfulAt`, `route`, `setRoute`, `selectedId`,
  `detail`, `detailError`. Re-emplaza `snapshot()` entero en cada poll
  (`setSnapshot(snap)`), lo que obliga a `<For each={snapshot()?.X}>` a
  remontar filas aunque el contenido semántico sea idéntico (la identidad
  implícita de `<For>` es la referencia del array). Polling cada 2 s con
  `setInterval` + `AbortController` + `nextToken()` ya descarta respuestas
  tardías y aborts.
- `ui/src/api.js` (29 líneas) expone `getSnapshot`, `getNode`, `getActivity`,
  `search`. Cada llamada acepta `{ signal }` para abortar. `getNode(id)`
  hace un GET puntual que el store cachea en `detail()` con token propio.
- `ui/server/server.mjs` (583 líneas) re-lee el state file en cada request
  (`freshState()`), deriva `deriveV2` + `statusOfV2`, calcula `summary`,
  `initiative_summary`, `last_activity`, `alerts` (state-read-error +
  stale-claim) y `recent_activity`. Endpoints: `/api/health`,
  `/api/snapshot`, `/api/node/:id`, `/api/activity`, `/api/search`. El
  detail devuelve `{ node, blocking, dependents, informing, knowledge,
  history, refs, derived_status, is_current, superseded_by }`.
- `ui/src/App.jsx` (807 líneas) compone el shell: `StoreProvider`,
  `RouteSync`, `Sidebar`, `Header` con `InitiativePicker` (lista iniciativas
  escaneando `nodes` con filtro `subkind ∈ {task, gate}` y excluyendo
  estados terminales), `Drawer`, `Main` con banners de error/route,
  `InitialState`, `UninitializedPanel`, `RouteView`. Lee `snapshot()`,
  `route()`, `initialLoading()`, `snapshotError()`, `lastSuccessfulAt()`
  directamente desde `useStore()`.
- `ui/src/components.jsx` (663 líneas) exporta primitivos presentacionales.
  Los `<For>` compartidos son `ProgressBar` (segments) y `Skeleton` (rows).
  El resto de primitivos son funciones puras (`kindFor`, `fmtTime`,
  `lastActionLabel`) o componentes single-element sin `<For>`.
- Vistas (`ui/src/views/`):
  - `Board.jsx` (409): 4 columnas por status + columna opcional de gates
    abiertas. Itera `derived().ready/blocked/backlog` y barre `nodes` por
    `status === "in_progress"`. Cards iteran con `<For each={col.cards}>`
    donde `cards` es un array construido por `tasksByStatus().filter(...)`
    — el array cambia de referencia en cada poll aunque las entidades sean
    las mismas. `principalBlocker`/`liveBlockerCount` se calculan por card.
  - `Nodes.jsx` (483): filtros + sort + grid; renderiza `<For each={sorted()}>`.
    `sorted()` parte del array `Object.values(nodes())` filtrado y ordenado
    localmente; cambia de referencia en cada poll.
  - `Gates.jsx` (433): filtros + tabs (`active`/`superseded`/`resolved`/`all`)
    + `grouped()` por iniciativa; renderiza `<For each={grouped()}>` →
    `<For each={list}>` con `<GateRow>`. `grouped()` se reconstruye en
    cada poll.
  - `Knowledge.jsx` (550): tabs + filtros (initiative, knowledge_type,
    scope dimension/value, deprecated toggle) + grid de cards.
    `<For each={groups()}>` → `<For each={g.items}>`. `groups()` se
    reconstruye por poll; las cards tienen identidad por `node.id` pero
    el array cambia.
  - `Overview.jsx` (772): 4 MetricCard (ready/in_progress/blocked/backlog),
    attention blocks (stale/blocked/open_gates/placeholders), initiatives
    cards, recent activity (max 8). 8 `<For>` distintos, todos sobre
    `createMemo` que re-corren por poll.
  - `Activity.jsx` (453): consume `getActivity()` directamente (no usa
    `snapshot()`); 1 `<For each={entries()}>` + `<For each={facets()}>`
    + `<For each={PAGE_SIZES}>` (constante). La paginación y filtros
    tienen su propio `nextToken()` y abort. Cada entry se keya por
    `${ts}::${action}::${agent}::${node_id}` (función `rowKey`).
  - `NodeDetail.jsx` (1061): consume `detail()` (cargado bajo demanda al
    `select(id)`) más `selectedId()`, `detailError()`. 11 `<For>`
    distintos sobre relaciones, refs, knowledge, history, notes, blockers,
    tags. La cache de detalle se invalida al cambiar `selectedId`.
  - `Finder.jsx` (432): overlay de búsqueda, usa `search()` directo, no
    depende del store reconciler. Independiente del plan.
- `ui/src/shell.mjs` (127) y `ui/src/routes.mjs` (80) son puros sin
  dependencias del snapshot.
- `ui/src/main.jsx` (5) monta `App` en `#root`. Sin cambios.
- Tests: `npm run test:ui` corre `test/ui-*.test.mjs` (13 archivos). El
  loader `test/jsx-loader.mjs` soporta `UI_JSX_GENERATE=dom` para
  tests que renderizan en jsdom (ya usado por algunos; otros usan SSR
  puro). Ningún test actual verifica identidad DOM de `<For>` ni
  persistencia de `scrollTop`/`scrollLeft` entre polls — ambos serán
  añadidos por las tasks hijas.

## 2. Mapa de módulos/entrypoints y seams

Texto = estado actual; sufijo `(V2)` = lo que añade el plan.

```text
ui/server/server.mjs                       snapshot/detail/activity/search GETs
  └─── /api/snapshot                  → { project, generated_at, initiatives,
                                          nodes, edges, derived, last_activity,
                                          initiative_summary, summary, alerts,
                                          recent_activity }
  └─── /api/node/:id                  → { node, blocking, dependents, informing,
                                          knowledge, history, refs,
                                          derived_status, is_current,
                                          superseded_by }
  └─── /api/activity                  → { entries, total, limit, offset,
                                          facets: { actions, agents } }
  └─── /api/search                    → { tasks, gates, knowledge }            (Finder, fuera del plan)

ui/src/api.js                              fetch wrappers con AbortSignal       (V2: keys de error identidad)

ui/src/store.jsx                           StoreProvider monolítico             (V2)
  └─── ui/src/store/createStore.js         createReactiveStore() (V2)
  └─── ui/src/store/reconcile.js           reconcile(prev, next) (V2)
  └─── ui/src/store/selectors.js           selectors de entities/views (V2)
  └─── ui/src/store/transport.js           polling + token + abort              (V2: snapshot conservado en error)
  └─── ui/src/store/detail.js              detail cache + detalle bajo demanda  (V2: reutiliza entity base)

ui/src/App.jsx                             shell, route sync, banners           (V2: usa selectores)
ui/src/components.jsx                      primitivos                           (sin cambios por contrato)
ui/src/shell.mjs                           helpers puros (sidebarWidthPx, …)    (sin cambios)
ui/src/routes.mjs                          metadata de rutas                    (sin cambios)

ui/src/views/Board.jsx                     kanban + columnas                    (V2: identity por node.id)
ui/src/views/Nodes.jsx                     filtros + sort + grid                (V2: identity por node.id)
ui/src/views/Gates.jsx                     filtros + tabs + grupos               (V2: identity por node.id)
ui/src/views/Knowledge.jsx                 filtros + grid                       (V2: identity por node.id)
ui/src/views/Overview.jsx                  métricas + attention + initiatives   (V2: keys estables agregadas)
ui/src/views/Activity.jsx                  log paginado                         (V2: rowKey determinista)
ui/src/views/NodeDetail.jsx                drawer                               (V2: nodes[id] + details[id])
ui/src/views/Finder.jsx                    búsqueda directa (search API)        (fuera del plan)
```

Seams explícitos (todos viven en `ui/src/store/` después del split):

| Seam | Tipo | Productores | Consumidores |
|---|---|---|---|
| `createReactiveStore({ fetchers })` | función | `T-store-foundation` | `StoreProvider` (único caller) |
| `reconcile(prev, next)` | función pura | `T-store-foundation` | `createReactiveStore` (interno) |
| Selectores (p. ej. `tasksByStatus()`, `nodesMap()`) | funciones puras | `T-store-foundation` | todas las vistas migradas |
| `useStore()` fachada | contexto | `T-store-foundation` | App + 8 vistas |
| `detail(id)` cache | `createSignal` + Map | `T-store-foundation` | `NodeDetail`, `select(id)` |
| `entities.plugins` namespace | slot aditivo en `nodes[id]` y raíz | server (snapshot aditivo) | `T-plugin-ui-rfc` (futuro) |

Los seams son imports directos. Ningún seam se expone por props, eventos
ni global; el único consumidor externo sigue siendo `useStore()`. Esto
preserva la frontera pública del ADR.

## 3. Contratos compartidos que deben preceder consumidores

### 3.1 Fachada `useStore()` (14 keys, congelada)

Las 14 keys se conservan literalmente; renombrar o eliminar una es
breaking change reservado a un ADR posterior:

```text
snapshot, error, loading, initialLoading, refreshing,
snapshotError, lastSuccessfulAt, route, setRoute, selectedId,
select, detail, detailError, reload
```

- `error` y `loading` se mantienen como alias legacy de `snapshotError`
  e `initialLoading` para no romper consumidores que aún las lean.
- `snapshot()` y `detail()` se preservan como accesores de compatibilidad;
  el código migrado debe consumir selectores y nunca la referencia completa
  como identidad de `<For>`.
- `select(id)` cancela el detail anterior y arranca uno nuevo (idéntica
  semántica). `reload()` reintenta el snapshot conservando el anterior
  si falla.
- `route`/`setRoute` siguen siendo de UI; no se mueven al store reactivo
  de entities.

Este contrato lo materializa `T-store-foundation` y lo verifican
`T-board-live` y cada migración de vista con un test que enumera las
14 keys (`Object.keys(useStore()).sort()`).

### 3.2 Slices del store reactivo

```text
transport: { generated_at, initialLoading, refreshing, snapshotError,
             lastSuccessfulAt, readAlerts, lastSnapshotAt }
ui:        { route, setRoute, selectedId, detailId, detail, detailError }
entities:  { nodes: Record<id, Node>, initiatives: Record<name, Init>,
             edges: Edge[], plugins: Record<pluginId, { data, meta? }> }
views:     { derived: { ready, blocked, backlog, openGates },
             tasksByStatus(), gatesByInitiative(), knowledgeByGroup(),
             activityRows(), alertsByKind(), initiativeRows() }
```

`generated_at` vive en transport, no en entities. Un snapshot nuevo
actualiza `transport.generated_at` y solo reemplaza una entity si su
`revision` o contenido cambió. `entities.plugins` se inicializa a `{}`
aunque el snapshot no traiga `plugins`. Los selectores `views.*` se
exportan con la misma firma para todas las vistas migradas.

Este contrato lo crea `T-store-foundation` (archivos puros en
`ui/src/store/`) y lo consumen las migraciones por vista.

### 3.3 Reconciliación por identidad

`solid-js/store` provee `reconcile(value, { key })`. La función
`reconcile(prev, next)` aplica reconciliación top-level sobre:

- `entities.nodes` con `key: "id"` (id ya es estable).
- `entities.initiatives` con `key: el nombre de la iniciativa`.
- `entities.edges` como array ordenado por `${from}::${to}::${type}` para
  que dos edges idénticos en posiciones distintas tengan identidad
  estable.
- `entities.plugins` con `key: pluginId`.

Vistas NO deben llamar a `reconcile` directamente; consumen selectores
que ya devuelven arrays con identidad estable. El Board pasa de filtrar
`nodes` por status a iterar `selectors.tasksByStatus()`, que devuelve
`{ ready: Node[], in_progress: Node[], blocked: Node[], backlog: Node[] }`
donde cada `Node` es la referencia estable del store reconciliado.

### 3.4 Claves estables para colecciones sin ID natural

| Vista | Colección | Key |
|---|---|---|
| Board | columnas | literal `ready`/`in_progress`/`blocked`/`backlog`/`open_gates` |
| Board | cards por columna | `node.id` |
| Overview | métricas | literal `ready`/`in_progress`/`blocked`/`backlog` |
| Overview | attention blocks | `${kind}::${node_id ?? ""}` |
| Overview | initiative rows | `initiative` (string) |
| Overview | activity preview | `${ts}::${action}::${node_id ?? ""}` (o `event_id` cuando exista) |
| Activity | entries | `${ts}::${action}::${agent}::${node_id}` (existente en `rowKey`) o `event_id` |
| Activity | facets | valor del facet (string) |
| NodeDetail | relations | `edge.id` virtual = `${from}::${to}::${type}` |
| NodeDetail | refs | `${target}::${type}::${source}` (mismo key que `normalizeRef` ya deduplica) |
| NodeDetail | knowledge | `knowledge.id` |
| NodeDetail | history | `${ts}::${action}::${agent}::${node_id}` |
| NodeDetail | notes | índice estable (ya existe `revision` por nota o `at`) |
| Gates | grupos | `initiative` (string) o `"—"` |
| Knowledge | grupos | `${kind}::${scope_dimension}::${scope_value}` |

`Overview.activityMemo()` y `Activity.entries()` aún no tienen un
`event_id` durable; mientras el server no lo emita, se keya por la
tupla `ts::action::agent::node_id`. `T-activity-events` (cuando se cree)
introducirá el `event_id` aditivo en el servidor sin romper este plan.

### 3.5 Cache base de detalle

`detail()` se conserva en el slice `ui` del store. Al hacer
`select(id)`:

1. Si `entities.nodes[id]` existe, la entidad base ya está sincronizada
   vía reconciliación; no hace falta un GET inmediato.
2. Se hace `GET /api/node/:id` para traer `blocking`, `dependents`,
   `informing`, `knowledge`, `history`, `refs` — los "extras" del
   detail. Esos viven en `details[id]` (slot aditivo del slice `ui`,
   paralelo a `entities.nodes`).
3. Si llega un poll que actualiza `entities.nodes[id]`, los extras en
   `details[id]` siguen válidos hasta que el usuario refresque o el
   detail mismo se re-pida. Un cambio de `status`/`revision` en la
   entidad base NO reemplaza el detail entero.
4. Cancelar/abortar el detail en curso sigue usando `detailToken`.

Este contrato lo implementa `T-store-foundation` y lo verifica
`T-node-detail-live` con un test que confirma que cambiar
`entities.nodes[id].status` no reemplaza la entry `details[id]`.

### 3.6 Plugins namespace (read-only en esta entrega)

`entities.plugins` y `entities.nodes[id].plugins` son slots read-only
para esta entrega. Se acepta el namespace aunque el snapshot no lo
traiga (`plugins` ausente → `{}`). No se ejecuta código de plugin, no
se interpreta HTML/JS, no se renderiza nada desde ese namespace en
esta fase. `G-plugin-ui-rfc` continúa siendo dueño del descriptor y
slots de render.

Este contrato lo fija `T-store-foundation` (normalización) y lo testea
`T-plugin-snapshot-namespace` (verificación) sin render.

## 4. Cortes de tasks con paths exclusivos

Seis tasks, cada una con un único cambio principal, paths verificables,
no-go zones explícitas y comandos de aceptación.

### 4.1 `T-store-foundation` — Store reactivo con reconciliación y fachada

- **Cambio principal**: dividir `ui/src/store.jsx` monolítico en
  `ui/src/store/` (módulos puros) + un `StoreProvider` que monta el
  store reactivo de `solid-js/store` con reconciliación por
  `id`/`name`/`${from}::${to}::${type}`/`pluginId`. Conservar las
  14 keys de `useStore()`. Normalizar `plugins` ausente a `{}`. Mover
  la cache de detail a `ui.detail[id]` sin tocar `entities.nodes[id]`.
- **Paths propios**:
  - `ui/src/store.jsx` (re-escrito como fachada delgada).
  - `ui/src/store/createStore.js` (nuevo).
  - `ui/src/store/reconcile.js` (nuevo).
  - `ui/src/store/selectors.js` (nuevo).
  - `ui/src/store/transport.js` (nuevo).
  - `ui/src/store/detail.js` (nuevo).
  - `ui/src/store/index.js` (nuevo; barrel para import interno).
  - `test/ui-store-foundation.test.mjs` (nuevo; enumera 14 keys,
    prueba identidad, prueba `plugins` ausente → `{}`, prueba detail
    no se reemplaza al cambiar entity base).
- **No-go zones**: `ui/server/server.mjs`, `App.jsx`, `components.jsx`,
  `views/`, `shell.mjs`, `routes.mjs`, `api.js`, `main.jsx`,
  `index.css`, fixtures, `docs/`, `.adrs/`, `.decisions/`. La fachada
  pública es la única API exportada; el resto de la app no debe
  importar `ui/src/store/*` directamente, solo `useStore`/`StoreProvider`.
- **Acceptance**: ver §7.

### 4.2 `T-board-live` — Board con identidad estable y persistencia de scroll

- **Cambio principal**: `Board.jsx` pasa de filtrar `nodes` en cada
  poll a consumir `selectors.tasksByStatus()` y
  `selectors.openGates()`. Las columnas se iteran con key estable
  (literal status). Las cards dentro de cada columna keyan por
  `node.id`. La columna de gates desaparece cuando no hay gates
  abiertas (sin remontaje cuando el filtro deja 0 gates: el slot se
  desmonta). `principalBlocker`/`liveBlockerCount` siguen funcionando
  por card.
- **Paths propios**:
  - `ui/src/views/Board.jsx` (refactor; usa selectores).
  - `test/ui-board-live.test.mjs` (nuevo; usa `UI_JSX_GENERATE=dom`
    y jsdom para verificar identidad DOM tras 3 polls idénticos:
    `column[0].isSameNode(columnBefore[0])` y lo mismo por card;
    `Board.scrollLeft === 180`, `column[2].scrollTop === 240` se
    preservan).
- **No-go zones**: `store/`, `App.jsx`, `views/Nodes.jsx`,
  `views/Gates.jsx`, `views/Knowledge.jsx`, `views/Overview.jsx`,
  `views/Activity.jsx`, `views/NodeDetail.jsx`, `components.jsx`,
  `server.mjs`.
- **Acceptance**: ver §7.

### 4.3 `T-listas-operativas` — Nodes, Gates y Knowledge con identidad

- **Cambio principal**: las tres vistas de listas migran de arrays
  reconstruidos en cada poll a iterar selectores. `Nodes` keya por
  `node.id` y usa `${initiative}::${status}::${id}` para grupos
  visuales cuando aplique. `Gates` keya por `node.id` dentro de
  cada grupo de iniciativa. `Knowledge` keya por `node.id` dentro de
  cada grupo de scope. El sort local y los filtros siguen siendo
  client-side sobre selectores, no se introducen nuevos.
- **Paths propios**:
  - `ui/src/views/Nodes.jsx` (migración a selector + key estable).
  - `ui/src/views/Gates.jsx` (idem).
  - `ui/src/views/Knowledge.jsx` (idem).
  - `test/ui-listas-live.test.mjs` (nuevo; tres sub-tests, uno por
    vista, cada uno verifica identidad de filas tras 3 polls idénticos
    y un movimiento de status entre columnas sin remontaje de
    hermanas).
- **No-go zones**: `store/`, `Board.jsx`, `Overview.jsx`, `Activity.jsx`,
  `NodeDetail.jsx`, `App.jsx`, `components.jsx`, `server.mjs`.
- **Acceptance**: ver §7.

### 4.4 `T-overview-shell` — Overview, App.jsx y NodeDetail con cache base

- **Cambio principal**: `Overview.jsx` pasa a consumir selectores
  agregados (`metrics`, `alertsByKind`, `initiativeRows`, `activityMemo`)
  con keys estables por métrica, alert kind e initiative name.
  `App.jsx` reemplaza lecturas directas de `snapshot()` por
  selectores donde aplica (banner de state-read-error sigue leyendo
  transport; `InitiativePicker` puede seguir escaneando `entities.nodes`
  porque es una vista derivada de la entity map, no una colección
  `<For>`). `NodeDetail.jsx` consume `entities.nodes[id]` directamente
  del slice reconciliado y los extras siguen viniendo de `details[id]`
  cache.
- **Paths propios**:
  - `ui/src/views/Overview.jsx` (selectores + keys).
  - `ui/src/App.jsx` (lecturas selectivas; sin refactor mayor).
  - `ui/src/views/NodeDetail.jsx` (entity base + details[id]).
  - `test/ui-overview-live.test.mjs` (nuevo; verifica identidad de
    metric cards, attention blocks e initiative rows tras 3 polls
    idénticos, y que `NodeDetail` no remonta al cambiar
    `entities.nodes[id].status`).
- **No-go zones**: `store/`, `Board.jsx`, `Nodes.jsx`, `Gates.jsx`,
  `Knowledge.jsx`, `Activity.jsx`, `components.jsx`, `server.mjs`.
- **Acceptance**: ver §7.

### 4.5 `T-activity-keys` — Activity con keys de evento estables

- **Cambio principal**: `Activity.jsx` reemplaza el key actual
  `${ts}::${action}::${agent}::${node_id}` (que ya es estable dentro
  de la misma página) por un `rowKey()` que prefiere `event_id` si
  el server lo emite (server aditivo) y cae a la tupla actual si no.
  Los facets siguen keyando por valor (acción/agent). La paginación
  no cambia.
- **Paths propios**:
  - `ui/src/views/Activity.jsx` (`rowKey` actualizado; tests de
    identidad).
  - `test/ui-activity-live.test.mjs` (nuevo; verifica que dos
    respuestas paginadas que comparten el último item mantienen la
    misma fila DOM y que el filtro no remonta filas que no cambiaron).
  - Si el server no emite `event_id`, este cambio es 100 % client-side
    y NO toca `server.mjs`.
- **No-go zones**: `store/`, `Board.jsx`, `Nodes.jsx`, `Gates.jsx`,
  `Knowledge.jsx`, `Overview.jsx`, `NodeDetail.jsx`, `App.jsx`,
  `components.jsx`.
- **Acceptance**: ver §7.

### 4.6 `T-plugin-snapshot-namespace` — Verificación aditiva de plugins

- **Cambio principal**: test de verificación que confirma que un
  snapshot con `entities.plugins = { foo: { data: {…} } }` y
  `entities.nodes[id].plugins = { foo: { data: {…} } }` no rompe
  ninguna vista ni el reconciliador. Esta task NO renderiza plugins;
  solo deja sentada la frontera para `G-plugin-ui-rfc` (que sigue
  siendo dueño del render).
- **Paths propios**:
  - `test/ui-plugin-snapshot-namespace.test.mjs` (nuevo; usa el
    server de `ui/server/server.mjs` real con un state extendido
    aditivamente y verifica que `useStore().snapshot.plugins` se
    expone como `{}` cuando falta y como el objeto cuando está).
  - `test/fixtures/plugin-namespace-state.mjs` (nuevo; fixture
    minimal con `plugins` raíz y `nodes[id].plugins`).
- **No-go zones**: `store/` (salvo un import nuevo desde el test,
  ningún cambio), `App.jsx`, vistas, `components.jsx`, renderizadores
  de plugin, descriptor de plugin, runtime de plugin.
- **Acceptance**: ver §7.

## 5. DAG y dependencias

```text
                          T-ui-live-store-bootstrap
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
  T-store-foundation   T-plugin-snapshot-ns     T-activity-keys (no depende del foundation)
        │                       │                       │
        ├──────────────┬────────┼────────┬──────────────┤
        ▼              ▼        ▼        ▼              ▼
  T-board-live   T-listas-ops  T-overview-shell        │
        │              │        │                       │
        ▼              ▼        ▼                       │
                          (fin)                         │
```

Tabla de dependencias:

| Task | Bloqueada por |
|---|---|
| `T-store-foundation` | `T-ui-live-store-bootstrap` |
| `T-plugin-snapshot-namespace` | `T-ui-live-store-bootstrap` |
| `T-activity-keys` | `T-ui-live-store-bootstrap` |
| `T-board-live` | `T-store-foundation` |
| `T-listas-operativas` | `T-store-foundation` |
| `T-overview-shell` | `T-store-foundation` |

`T-plugin-snapshot-namespace` y `T-activity-keys` no requieren el store
reactivo (verifican el server y un cliente anterior respectivamente) y
pueden correr en paralelo con `T-store-foundation`. `T-board-live`,
`T-listas-operativas` y `T-overview-shell` requieren el store
fundación para consumir selectores.

Todas las tasks hijas emiten `BLOCKS` con `from: <padre>, to: <hija>`
hacia la dependencia. La dirección canónica se respeta.

## 6. Batches paralelos

Después de que `T-ui-live-store-bootstrap` quede resuelta:

- **Batch A (3 workers en paralelo, requiere bootstrap cerrado)**:
  - `T-store-foundation` (única owner de `ui/src/store/` y `store.jsx`).
  - `T-plugin-snapshot-namespace` (test-only, no toca `store/`, toca
    `test/fixtures/` y un test nuevo).
  - `T-activity-keys` (única owner de `Activity.jsx`; key estable
    client-side, sin cambios de server).
  - **Sin conflicto**: paths disjuntos. `T-plugin-snapshot-namespace`
    no importa `ui/src/store/` para sus asserts (consume el snapshot
    por HTTP). `T-activity-keys` no toca los selectores porque
    Activity sigue usando `getActivity()` directo.

- **Batch B (3 workers en paralelo, requiere Batch A cerrado)**:
  - `T-board-live` (única owner de `Board.jsx`).
  - `T-listas-operativas` (owners disjuntos: Nodes, Gates, Knowledge,
    un worker con tres archivos o tres workers separados por archivo).
  - `T-overview-shell` (owners disjuntos: Overview, App, NodeDetail).
  - **Sin conflicto**: paths disjuntos por construcción. Las tres
    tasks sólo importan selectores desde `ui/src/store/selectors.js`;
    si el surface de selectores cambia durante Batch B, los tres se
    reabren y se ajustan. La probabilidad de colisión es baja porque
    el contrato §3.2 está congelado en este plan.

`T-board-live` exige tests con `UI_JSX_GENERATE=dom`; los otros Batch B
pueden usar SSR puro o dom según convenga al worker, pero no comparten
harness.

## 7. Comandos de verificación

Cada task debe pasar, en orden:

| Task | Comando |
|---|---|
| `T-store-foundation` | `node --test test/ui-store-foundation.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |
| `T-board-live` | `node --test test/ui-board-live.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |
| `T-listas-operativas` | `node --test test/ui-listas-live.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |
| `T-overview-shell` | `node --test test/ui-overview-live.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |
| `T-activity-keys` | `node --test test/ui-activity-live.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |
| `T-plugin-snapshot-namespace` | `node --test test/ui-plugin-snapshot-namespace.test.mjs`, `node --test test/ui-live.test.mjs`, `npm run test:ui`, `npm test`, `git diff --check` |

Verificación global del ADR:

```bash
node --test test/ui-store-foundation.test.mjs \
         test/ui-board-live.test.mjs \
         test/ui-listas-live.test.mjs \
         test/ui-overview-live.test.mjs \
         test/ui-activity-live.test.mjs \
         test/ui-plugin-snapshot-namespace.test.mjs \
         test/ui-live.test.mjs
npm run test:ui
npm test
npm --prefix ui run build
git diff --check
```

Asserts de identidad/scroll (referencia para los tests de Batch B):

- 3 polls idénticos → `column[i].isSameNode(columnBefore[i])` y
  `card[i][j].isSameNode(cardBefore[i][j])`.
- `Board.scrollLeft === 180` y `column[2].scrollTop === 240` se
  conservan tras 3 polls idénticos.
- Cambiar título de una card → solo esa card remonta; las hermanas
  conservan identidad.
- Cambiar status de una card → un remove + un add; el resto conserva
  identidad.
- `useStore()` conserva las 14 keys.
- `generated_at` distinto entre dos snapshots NO reemplaza
  `entities.nodes[id]` (referencia estable).
- `entities.plugins` ausente se expone como `{}`.
- `entities.plugins` presente se expone intacto.
- En `NodeDetail`, cambiar `entities.nodes[id].status` por un poll
  NO reemplaza `details[id]`; los extras siguen siendo los del último
  `GET /api/node/:id`.

## 8. Riesgos que invalidarían el orden

1. **Store fundacional cambia durante Batch B.** Si `T-store-foundation`
   reabre y modifica la firma de un selector mientras `T-board-live` o
   `T-listas-operativas` corren, los workers de Batch B fallan en
   import. Mitigado: el contrato §3.2 está congelado en este plan; los
   selectores se nombran antes de implementar y el test de fundación
   los enumera. Si hace falta ajustar, Batch B se reabre como un
   bloque.

2. **`<For>` no acepta keys por string vacío.** Board tiene una columna
   opcional de gates que desaparece cuando `filteredGates().length === 0`.
   El slot `<Show when={filteredGates().length > 0}>` ya evita el caso;
   el plan lo mantiene. Mitigado: Board sigue usando `<Show>` para el
   slot, no `<For>` con sentinel.

3. **Activity y NodeDetail comparten `ts::action::agent::node_id`.**
   Si dos eventos tienen los mismos cuatro campos (mismo timestamp
   ISO con precisión de ms), la key colisiona y `<For>` remonta. No es
   un riesgo del plan: el server ya emite timestamps crecientes y
   `event_id` se introducirá cuando `T-activity-events` se cree. El
   fallback sigue siendo determinista y los workers no asumen
   monotonicidad.

4. **`scrollTop` se mide en píxeles y jsdom no implementa layout.**
   Los tests de Batch B que verifiquen persistencia de scroll deben
   usar `UI_JSX_GENERATE=dom` con jsdom y `dispatchEvent` para
   simular scroll programático. jsdom no resuelve layout real, así
   que el assert será: tras asignar `el.scrollTop = 240` y disparar
   dos polls idénticos, `el.scrollTop === 240`. Mitigado: el plan
   documenta el assert esperado para que los workers no inventen
   métricas falsas.

5. **`createMemo` no es estable si la fuente cambia de referencia.**
   Las migraciones por vista deben consumir selectores que devuelven
   arrays con identidad estable, no `createMemo` sobre `snapshot()`
   crudo. Mitigado: el contrato §3.3 obliga a que los selectores
   iteren `entities.nodes` (referencias reconciliadas) y los tests
   de fundación verifican que dos snapshots consecutivos con
   contenido idéntico producen `===` en cada node.

6. **`entities.plugins` se ignora en `init` o `add-node`.** El server
   debe preservar el namespace porque `JSON.stringify` ya lo hace,
   pero `T-plugin-snapshot-namespace` debe verificar el camino
   completo (init, take, resolve, update, snapshot, restore) con un
   state extendido. Si alguno lo borra, la task de verificación falla
   antes de mergear. Mitigado: la task de verificación se ejecuta
   contra el server real, no contra un mock.

7. **`server.mjs` decide emitir `event_id` durante este plan.** No
   está en el scope de las tasks hijas. `T-activity-keys` sigue
   funcionando con la key de fallback mientras tanto. Mitigado:
   ningún worker toca `server.mjs`.

8. **Tests de identidad con `UI_JSX_GENERATE=dom` requieren jsdom
   cargado.** `test/jsx-loader.mjs` ya soporta el modo. El primer
   test que lo use debe verificar que `ui/node_modules/jsdom` está
   presente; si falta, el test debe saltarse con `{ skip: "ui deps
   not installed" }` siguiendo el patrón de `test/ui-live.test.mjs`.

## 9. Decisiones explícitas

- **No se introduce un registry ni un `manifest.json` de plugins**.
  El ADR §4 fija que el host acepta datos namespaced sin interpretar.
  `T-plugin-snapshot-namespace` solo verifica; no renderiza.
- **El loader no cachea entre invocaciones del CLI**. Cada `climier ui`
  es un proceso nuevo, así que no se introduce invalidación.
- **`event_id` no entra en `server.mjs` durante este plan**. El
  fallback `${ts}::${action}::${agent}::${node_id}` es la key
  vigente. Cuando `T-activity-events` lo introduzca, será aditivo.
- **El reconciliador se aplica en el cliente, no en el server**. El
  server sigue emitiendo snapshots planos; el store cliente es el
  único que conoce la identidad estable.
- **El split `ui/src/store/` es interno**. La fachada `useStore()`
  sigue siendo la única API exportada a `App.jsx` y vistas.
  `ui/src/store/index.js` se usa solo para importar entre los
  módulos del subdirectorio; el resto importa `./store.jsx`.
- **`App.jsx` se modifica en `T-overview-shell`, no antes**. Los
  cambios se limitan a reemplazar lecturas directas de `snapshot()`
  por selectores donde aplique; sin refactor mayor.
- **`components.jsx` queda congelado** durante este plan. Si una
  vista necesita un primitive nuevo, lo agrega como helper local
  dentro del archivo de la vista o lo propone en un ADR posterior.
- **`Finder.jsx` queda fuera del plan**. Consume `search()` directo,
  no el snapshot, y su identidad ya es estable por su propio
  `AbortController` interno.
- **No se introduce ETag/304 ni `fs.watch`**. El server re-lee en
  cada request (knowledge `K-ui-live-state`) y el cliente hace
  polling. El ADR §"Consecuencias" lo confirma.

## 10. Lo que esta task no hace

- No implementa el store reactivo (lo delegará a `T-store-foundation`).
- No modifica `ui/src/`, `ui/server/`, `test/`, ni el shell.
- No toca `bin/`, `src/`, `docs/`, `.adrs/`, `.decisions/`.
- No crea tasks hijas en climier.
- No resuelve gates ni delega workers.
- No commitea nada fuera de `docs/plans/ui-live-store-execution.md`.

El cierre de `T-ui-live-store-bootstrap` deja: este plan commiteado en
la rama del worktree, y una nota de cierre con los ids propuestos y el
orden de batches. Ningún nodo nuevo en el DAG del CLI.