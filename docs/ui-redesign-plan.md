# Plan de rediseño de la UI de Climier

Plan generado por auditoría de la UI (`ui/`) con el estado real del proyecto. La UI es un
subproyecto autocontenido (Express server + Solid.js + Tailwind v4), read-only: proyecta el
estado del CLI. El CLI es la fuente de verdad; la UI no muta nada.

Estado observado al momento del plan: 14 nodes, 2 initiatives, 1 task ready (`T-ui-tests`),
1 task en backlog, 7 done, 2 gates resueltas, 3 knowledge activos, 0 gates abiertas,
0 stale, 0 blocked. El único trabajo ejecutable estaba escondido detrás de un contador:
el dashboard no respondía "qué requiere atención".

## 1. Diagnóstico transversal

### Jerarquía y densidad

- Casi toda la interfaz usa texto de 10–13 px, padding de 4–12 px y controles de ~26–30 px.
- Títulos, filtros, metadata, estados e IDs compiten en escalas casi idénticas.
- Las secciones usan el mismo fondo que elementos internos; borde y color no separan niveles.
- Labels monospace uppercase tracked agregan ruido.
- Empty states con borde dashed aparecen hasta en columnas pequeñas.

### Uso del espacio

- Sidebar fijo de 224 px, nunca colapsa.
- Board fuerza 4 columnas iguales aunque no entren.
- Gates, Knowledge y detalle usan filas full-width sin límite de lectura.
- Overview reparte info en bloques iguales sin distinguir trabajo, problemas, contexto e historial.
- Faltan `min-h-0` y dueño de scroll consistente en layouts flex.

### Contrato visual

- `index.css` declara tokens (canvas/ink/body/mute/panel/panel-2/mid/line) pero las vistas usan `slate-*`, `sky-*`, etc. directo.
- `body` casi no participa.
- Pills para todo (nav, badges, botones); inputs/cards con otro vocabulario.
- Sin focus-visible consistente.
- Color como principal diferenciador de estados.

### Flujo de datos y robustez (defectos a corregir ANTES del restyle)

1. El server busca `claim.ts` pero climier guarda `claim.at` → stale nunca aparece, fecha de claim vacía.
2. `deriveStatusFor()` en el server marca una gate abierta sin blockers como `ready` (debe ser `open`).
3. `Nodes.jsx` reimplementa la derivación: blocker inexistente se considera satisfecho; gates superseded mal; omite `archived`. La UI puede divergir del CLI.
4. Overview asume que todo alert tiene `a.claim.by`; un `state-read-error` sin claim puede romper el render.
5. Las initiatives del snapshot son un objeto cuyos valores no contienen `name` → las descripciones nunca se muestran.
6. `refsOf()` devuelve refs como objetos; NodeDetail las renderiza como strings.
7. Eventos `add-node` guardan el ID en `note`, no en `node` → Recent Activity no puede abrirlos, repite texto, ignora `node_title`.
8. Error de red durante polling reemplaza toda la UI aunque exista snapshot válido.
9. Requests async de selección/filtros sin cancelar; respuestas viejas pueden pisar detail o Activity.

## 2. Diagnóstico por vista

### Shell (`App.jsx`)
- Sidebar fijo sin tablet/mobile. Nav sin grupos/iconos. Routing local sin URL, deep links ni back/forward.
- `SwitchRoute` anidado; ruta desconocida cae en Activity. Aviso de proyecto no inicializado puede quedar fuera de pantalla.
- Sin indicador de refrescando/último snapshot válido/datos desactualizados.

### Overview
- 10 métricas con la misma jerarquía. No muestra tasks ready/in progress, solo números.
- La única card clickeable ejecuta `select(null)` (no hace nada). Secciones vacías ocupan espacio.
- Faltan placeholders, stale, open_decisions y archived. Initiatives mezclan tasks/gates/knowledge en total/done ambiguo.
- Activity cruda con notas truncadas. Active Knowledge sin límite.

### Board
- 4 columnas rígidas ilegibles en ventanas medianas. Cards con todo apiñado (ID, badge, título, chips, claim, notes, blockers, dependents, actividad).
- `blockers` cuenta todas las dependencias entrantes, incluso satisfechas. Historial mezcla tasks/gates/knowledge.
- Sin estado "sin trabajo activo" ni acceso al historial completo.

### Graph
- Zoom no escala contenido (cambia width/height del SVG, no transforma el grupo). Pan transforma el SVG entero.
- Nodos muestran casi solo el ID. Sin flechas, sin search/filtros/fit.
- `computeLayout()` repite scans de edges; no escala. Con el proyecto real, el filtro histórico oculto deja nodos desconectados.

### Nodes
- Se llama Nodes pero solo hay tasks. Tabla ultra compacta, 8 columnas, sin responsive.
- Filtro `open` casi inútil (las abiertas se ven ready/blocked/backlog). Falta archived. Deriva status distinto al CLI.
- Sin sorting operativo, filtros por domain/owner, ni clear. `tr` clickeable no accesible.

### Gates
- Sin filtro por initiative. Abiertas y resueltas mezcladas, orden por ID. Sin downstream impact.
- Rationale resuelta puede dominar la fila. Cards full-width en monitores grandes.

### Knowledge
- Scope/type/status/initiative como masa de chips de 10–11 px. Sin filtros.
- Borde violeta en todas las cards sobredimensiona el significado. Mitigation sin jerarquía propia.

### Activity
- Empty state durante carga inicial. Request por tecla sin debounce ni cancelación.
- Lista fija de acciones omite `add-edge`. Filtros agent/node parecen búsqueda pero son igualdad exacta.
- No usa `node_title`. Notas truncadas. `1–0 of 0` en vacío. Sin indicador de refresh.

### NodeDetail
- Todo abierto a la vez (spec, blocking, dependents, knowledge, notes, history, refs).
- `KindBadge` con `kind="resolvable"` en vez de `task` → clasificación visual incorrecta.
- Timestamp de claim mal. No expone informing/is_current/DERIVED_FROM. Blocker gate abierto se ve como `blocked`.
- Sin back entre nodes, Escape, focus management ni semántica de diálogo. Refs estructuradas sin modelo renderizable.

## 3. Qué aplica de `ui/DESIGN.md`

Ese doc describe un sitio de marketing de otro producto (Universal Sans, hero 96px, CTAs, pricing).
**No es la fuente de verdad del dashboard.**

- Conservar: paleta neutral clara, bordes finos, elevación contenida, escala base 4px, mono para IDs/comandos, acentos para estados, ausencia de decoración gratuita.
- Descartar: tipografía display de marketing, tracking negativo, peso 400 universal, pill para todo, hero bands, prohibición absoluta de sombras (drawer/popover sí necesitan separación), fuentes externas.
- Recomendación: reemplazar el contenido por un contrato de diseño específico de Climier y versionarlo junto al rediseño.

## 4. Dirección de diseño

Concepto: "mesa de operaciones" clara y tranquila.

1. Lo que requiere acción/atención aparece primero.
2. El contexto del proyecto después.
3. Historial y detalle por progressive disclosure.
4. Board, Graph y tablas aprovechan todo el ancho.
5. Overview, Gates y Knowledge con anchos de lectura controlados.

### Layout

- Desktop ≥1280: sidebar 240 px, gutter 32 px, Overview centrado max ~1440 px, Board/Graph/Tasks/Activity full-bleed.
- 768–1279: sidebar colapsable a rail 64–72 px, Board con columnas min 280 px + scroll horizontal.
- <768: topbar + drawer, detail full-screen, tablas con scroll horizontal o cards.
- Usar `100dvh`, `min-h-0`, un único dueño del scroll por vista.

### Tokens propuestos

| Token | Valor | Uso |
|---|---:|---|
| `canvas` | `#F6F7F9` | Fondo de aplicación |
| `panel` | `#FFFFFF` | Cards, tablas, superficies principales |
| `panel-2` | `#F1F3F5` | Superficies anidadas y hover |
| `mid` | `#E5E7EB` | Controles seleccionados, divisores fuertes |
| `line` | `#D9DEE5` | Bordes |
| `ink` | `#111318` | Títulos y contenido principal |
| `body` | `#3F4652` | Texto normal |
| `mute` | `#6B7280` | Metadata |
| `ready` | `#047857` | Ready/success |
| `progress` | `#0369A1` | In progress/claim |
| `blocked` | `#BE123C` | Bloqueo/error |
| `gate` | `#A16207` | Gate/decision |
| `knowledge` | `#6D28D9` | Knowledge |
| `focus` | `#2563EB` | Focus visible |

Agregar variantes soft accesibles. Los SVG deben usar estas variables.

### Tipografía

- Stack de sistema existente; no agregar fuentes.
- Page title 24/32 600 · Section title 16/24 600 · Body 14/20 · Metadata 12/16 · Métrica 30/36 600.
- Mono solo para IDs, timestamps técnicos, acciones y comandos. Nada menor a 12 px salvo labels internos del grafo.

### Espaciado y formas

- Base 4 px. Gutter 24–32. Separación de secciones 24. Padding de card 16–20. Fila de tabla 48–56.
- Controles desktop min 36 px; mobile 44 px. Card radius 12 px; control radius 8 px.
- Pill solo para statuses, tags y counters. Cards sin sombra por defecto; sombra moderada en drawer/popover.

### Componentes compartidos (`components.jsx`)

`PageHeader`, `Panel`, `MetricCard`, `StatusBadge`, `KindBadge`, `Chip`, `FilterBar`, `AlertBanner`,
`EmptyState` (variantes page/section/compact), `NodeRow`, `ProgressBar`, `LiveStatus`, `Skeleton`,
`IconButton`, `Time`.

`MetricCard` = `<button>` cuando navega, `<div>` cuando no. Todo interactivo con focus-visible, cursor y label accesible.

### Estados de datos

- Carga inicial: skeleton. Refresh de fondo: indicador no bloqueante. Error inicial: pantalla de error.
- Error posterior: conservar snapshot + banner. `state-read-error`: banner alta prioridad sobre último estado válido.
- Proyecto sin inicializar: empty state con comando CLI (nunca ejecutar la mutación).
- Inicializado sin nodes: empty state educativo. Filtros sin resultados: "Clear filters".
- Cero problemas: mensaje compacto positivo, no card dashed grande.

## 5. Overview rediseñado

1. **Header**: nombre/base del proyecto, "Registered Climier work only" y total nodes como contexto. El estado global de refresh/read-only vive en un único indicador flotante.
2. **Alertas globales** (solo si existen): state-read-error, stale claims, blockers anómalos.
3. **Operational status** (4 métricas primarias): Ready, In progress, Blocked, Backlog — cada una con número, explicación de una línea y navegación a Board/Tasks con filtro.
4. **Work now** (8 cols): Ready tasks ≤4 e In-progress tasks ≤4; fila con status, ID, título, initiative, owner/última actividad; click → NodeDetail. Con el estado actual debe verse `T-ui-tests` de inmediato.
5. **Needs attention** (4 cols): stale, blocked, open gates, open decisions, placeholders. Si todo es cero: una línea "No immediate coordination issues". Definiciones:
   - `open_decisions`: gates `open` con `purpose === "decision"`.
   - `placeholders`: tasks con `placeholder === true` (solo visualizar si existen; no reintroducir comandos).
   - `stale`: tasks `in_progress` cuyo `claim.at` excede el umbral.
   - `archived`: status persistido reconocido por el modelo.
6. **Initiatives**: fila/card por initiative (incluyendo las registradas sin nodes): descripción, task total, ready/in_progress/blocked/backlog, done/archived, open gates, barra segmentada por estados (no porcentaje que mezcle kinds). Orden: atención/actividad primero, luego alfabético.
7. **Recent activity** (8 cols, ≤8 eventos): tiempo relativo + timestamp absoluto en tooltip, acción humanizada, agente, título e ID del node, preview de note. `add-node` normalizado y clickeable.
8. **Project record** (4 cols, compacto): done, archived, canceled, superseded, resolved gates, active/deprecated knowledge — filas compactas enlazadas, no cards grandes.

Sin charts de tendencia: el snapshot no tiene series temporales.

## 6. Plan de implementación

### Fase 0 — Baseline
- Decidir el estado del worktree actual (commit/descartar) y versionar el reemplazo de `DESIGN.md`. No iniciar workers hasta dejar el worktree limpio.
- Acceptance: `git status --short` limpio.

### Fase 1 — Corregir el contrato de lectura
Archivos: `ui/server/server.mjs`, `ui/src/api.js`, `ui/src/store.jsx`, `test/ui-live.test.mjs`.

1. Server: usar `statusOfV2()` para `derived_status`; claims con `claim.at` (fallback `claim.ts`); stale solo en tasks `in_progress`; `project_id` desde `.climier.json`; alerts normalizados (`kind`, `severity`, `message`, `node_id`); actividad normalizada (`node_id`, `node_title`); refs como `{ target, type, source }`; conservar `blocking` y separar dependents `BLOCKS` de otras relaciones.
2. Expandir `summary`: ready, in_progress, blocked, backlog, placeholders, stale, open_gates, open_decisions, done, archived, canceled, resolved_gates, superseded, active_knowledge, deprecated_knowledge, total_nodes.
3. Exponer `initiative_summary` con breakdown separado de tasks, gates y knowledge.
4. Store: `derivedStatusById` desde pools del server; separar `initialLoading`/`refreshing`/`snapshotError`/`lastSuccessfulAt`; conservar último snapshot si falla un poll; cancelar requests viejas (AbortController o tokens de secuencia).
5. API: aceptar `signal` en `jget`, `getSnapshot`, `getNode`, `getActivity`, `search`.
6. Tests primero (fallidos): gate abierta sigue `open`; stale usa `claim.at`; summary incluye archived/placeholders/open decisions; state-read-error conserva snapshot; refs estructuradas; requests GET no modifican el state.

Acceptance: ninguna vista reimplementa semántica de blockers; snapshot devuelve cero para métricas ausentes; error de refresh no borra UI; sin endpoints de escritura.
Verificación: `node --test test/ui-live.test.mjs` y `npm test`.

### Fase 2 — Tokens y componentes base
Archivos: `ui/src/index.css`, `ui/src/components.jsx`, `ui/DESIGN.md`.

Paleta/escalas/radios/focus vía Tailwind v4 `@theme`; tokens semánticos ready/progress/blocked/gate/knowledge/focus; base styles focus-visible/selection/reduced-motion; componentes compartidos + variantes de empty/loading/error; reemplazar `DESIGN.md`; labels en inglés; sin fuentes ni icon libs nuevas.
Acceptance: controles ≥36 px; nada <12 px (excepto grafo); pills solo en badges/chips; navegación y cards con teclado; colores semánticos acompañados de texto/forma.
Verificación: `cd ui && npm run build`.

### Fase 3 — Shell, navegación y estados globales
Archivos: `ui/src/App.jsx`, `ui/src/store.jsx`, `ui/src/components.jsx`, `ui/vite.config.mjs`, `ui/package.json`.

Registry de rutas (reemplaza SwitchRoute); hash sync sin router; grupos de nav (Monitor: Overview/Board/Graph · Work: Tasks/Gates · Context: Knowledge · History: Activity); nombre de proyecto y root; un único indicador flotante de live status/read-only; sidebar expandido/rail/drawer; estado no inicializado como contenido principal; errores de background como banner conservando datos; `aria-current`, focus, targets; proxy Vite `/api` → `127.0.0.1:7373`; script `dev:api`.
Acceptance: back/forward cambia vista; refresh conserva ruta; shell OK a 1440/1024/390; proyecto no inicializado muestra comando sin ejecutarlo; nav sobrevive a error posterior.
Verificación: `npm run dev:api` + `npm run dev -- --host 127.0.0.1`.

### Fase 4 — Overview (vertical slice)
Archivos: `ui/src/views/Overview.jsx`, `ui/src/components.jsx`.

Arquitectura de la sección 5; eliminar grilla de 10 métricas; entidades reales en Work now/Needs attention; `initiative_summary`; alerts por kind; listas limitadas con "View all"; `navigate(route, params)`; sin paneles vacíos grandes; sin charts.
Acceptance con estado actual: `T-ui-tests` en primera pantalla; las 2 initiatives con descripción; cero open gates/stale/blocked → un único estado saludable compacto; done/knowledge como record secundario; `add-node K-ui-live-state` una sola vez y abre detail; ningún metric card falso-clickeable.
Verificación: `npm run build` + revisión visual 1440×900, 1024×768, 390×844.

### Fase 5 — Vistas especializadas (4 tracks en paralelo)

Contrato congelado: `components.jsx`, `store.jsx` y el snapshot no se tocan en estos tracks (excepto Track D en server/api). Primitives faltantes se agregan en integración breve, no desde varios branches.

**Track A — Board y Tasks** (`Board.jsx`, `Nodes.jsx`): columnas `minmax(280px,1fr)` + scroll horizontal; headers sticky con count/explicación; cards padding 16, menos metadata, jerarquía clara; blocker principal solo en tasks blocked; open gates como rail superior colapsable (oculto si no hay); historial mezclado → link a Tasks filtrado; título "Tasks" (el archivo puede seguir llamándose Nodes.jsx); eliminar derivación local; archived/claimed-by/domain/reset/sorting operativo; filas accesibles como botón/link; tabla min-width + cards en mobile. Acceptance: ninguna card <280 px; Board no mezcla gates/knowledge con task history; status coincide con snapshot; filtros vacíos ofrecen Clear filters; sin drag-and-drop.

**Track B — Gates y Knowledge** (`Gates.jsx`, `Knowledge.jsx`): Gates con tabs Open/Resolved/All + initiative/purpose/search; open gates primero con downstream impact; resolution como preview 2 líneas, detalle en drawer; Knowledge con filtros initiative/type/scope/deprecated; scope agrupado por dimensión; mitigation como callout secundario; grid 2 cols solo con ancho suficiente; accent en badge/icon, no borde completo. Acceptance: gate abierta se distingue con impacto; rationale larga no domina; knowledge legible con muchos scopes; deprecated con contraste accesible.

**Track C — Graph** (`Graph.jsx`): adjacency maps antes del layout; zoom/pan sobre `<g transform=...>`; Fit/Reset + % zoom; markers SVG con flechas; node muestra ID + kind/status + título abreviado; search, initiative, status/kind, Show history; focus de vecinos (resaltar/atenuar); default sin knowledge desconectado; callout si hay nodes sin relaciones visibles; keyboard para nodes SVG; sin librería de graph. Acceptance: wheel escala tamaño real; pan no desplaza página; Fit muestra todo; dirección blocker→blocked clara sin depender del color; Show history visualiza la cadena histórica.

**Track D — Activity** (`Activity.jsx`, `api.js`, `server.mjs`, `test/ui-live.test.mjs`): `q` e `initiative` en el endpoint; facets de actions/agents; actions derivadas del log; debounce 250–300 ms + cancelación; skeleton inicial y error no destructivo; tabla cómoda (hora, acción, agente, título/ID, note preview); note completa al expandir; corregir paginación vacía; refresh manual con estado. Acceptance: sin flash de empty en loading; requests viejas no pisan; `add-edge` y futuras en filtros; empty `0 of 0`; `node_title` usado.

### Fase 6 — NodeDetail y relaciones
Archivos: `NodeDetail.jsx`, `store.jsx`, `components.jsx`, `server.mjs`, `test/ui-live.test.mjs`.

Header sticky con back/close/kind correcto/status/ID; título 20–24; resumen status/initiative/claim/revision/última actividad; callout para blocked/stale/superseded; spec y blockers relevantes abiertos por defecto; knowledge/notes/history/refs/relaciones secundarias en `<details>`; separar blockers entrantes / nodes bloqueados / DERIVED_FROM / SUPERSEDES-superseded_by / informing; navegación back entre nodes; Escape + focus inicial + devolución + `role="dialog"`; `Time` usa `claim.at`; refs muestran type/source con copy, sin renderizar Markdown/HTML; "Equivalent CLI command" con Copy, nunca ejecutar.
Acceptance: gate abierta muestra `open`; task claimed con fecha correcta; refs estructuradas distinguidas; recorrer blocker→node→back sin cerrar; operable con teclado; sin requests mutantes.

### Fase 7 — Integración, búsqueda y polish
Archivos: todos los anteriores.

Finder global con `/api/search` agrupado (Tasks/Gates/Knowledge); atajo `/` o Ctrl/Cmd+K, Escape, keyboard nav; auditoría labels/focus/contraste/targets; revisar empty/loading/error; truncados con tooltip/título accesible; un único scroll por vista; probar sparse/empty/uninitialized/fixture ~200 nodes; sin virtualización antes de medir; sin dark mode.

Acceptance final: Overview responde "qué requiere atención" sin abrir otra vista; Board responde "qué trabajo hay en cada estado"; Graph explica dependencia y dirección; Detail explica por qué un node está en su estado; UI conserva snapshot ante fallos de polling; sin POST/PATCH/DELETE ni escritura directa/indirecta; sin nuevas dependencias; teclado OK; build + suite verdes.
Verificación final: `cd ui && npm run build`; `node --test test/ui-live.test.mjs`; `npm test`; smoke `node server/server.mjs --project . --port 7374`; revisar 1440×900, 1280×800, 1024×768, 768×1024, 390×844, teclado, polling con detail abierto, error de API posterior a snapshot, proyecto vacío/no inicializado.

## 7. Orden y paralelismo

```text
Fase 0 baseline
  → Fase 1 contrato de lectura
  → Fase 2 tokens/componentes
  → Fase 3 shell
  → Fase 4 Overview
  → Fase 5A Board/Tasks ┐
    Fase 5B Gates/Knowledge ├─ en paralelo
    Fase 5C Graph           │
    Fase 5D Activity/API  ──┘
  → Fase 6 NodeDetail
  → Fase 7 integración
```

Condiciones: Fase 5 no edita `components.jsx`/`store.jsx`/contrato del snapshot (excepto Track D); Graph es el track más aislado; Activity es el único track de Fase 5 que toca server/api; NodeDetail espera contrato de relaciones estable.

## 8. Riesgos y tradeoffs

1. Worktree sucio antes de empezar (resolver en Fase 0).
2. `DESIGN.md` describe otro producto; reescribirlo.
3. Ampliar contrato del server con tests, en vez de duplicar derivación por vista.
4. Graph custom sin librería: pan/zoom/layout a implementar y validar.
5. Datos sparse vs dense: dashboard prioriza entidades reales, listas con límites y enlaces.
6. Sin series temporales: no inventar trends/velocity.
7. Responsive Board: scroll horizontal deliberado antes que comprimir cards.
8. Markdown plano, sin sanitización; refs copiables sin renderizar HTML.
9. Polling 2s razonable localmente; optimizaciones solo si la medición lo exige.
10. `placeholder`/`archived` se visualizan si existen; no reintroducir comandos públicos para crearlos.
