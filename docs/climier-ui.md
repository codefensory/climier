# Climier UI: tablero, DAG y contexto de nodos

**Estado:** propuesta de producto y diseño · **MVP implementado (lectura)** en `ui/`

## Decisiones tomadas

1. **Stack:** frontend Solid + Tailwind; backend Node.js + Express. Todo vive en la carpeta `ui/` como subproyecto con su propio `package.json` (el CLI raíz sigue stdlib-only; `climier ui` importa `ui/server/server.mjs`, que resuelve sus deps desde `ui/node_modules`).
2. **Comando:** `climier ui [--port N] [--open=true|false]` levanta el server en localhost (127.0.0.1:7373 por defecto), imprime el JSON del contrato y queda vivo sirviendo. Abre el navegador por defecto (desactivable con `--open=false`). Buildea `ui/dist` on demand si falta.
3. **Lecturas:** el server Node lee el state file con `readState` del propio CLI y deriva con `deriveV2` / `knowledgeForNode` / `blockingForNode` (cero drift de lógica). El snapshot se expone como endpoint `GET /api/snapshot`; no se crea un comando CLI `snapshot` por ahora. El browser nunca toca `tasks.json`.
4. **Sin mutaciones por ahora:** Fase 3 (acciones) e identidad del humano van a backlog. La UI es read-only y lo declara en la interfaz.
5. **Sin testing de la UI por ahora** (decisión explícita). La suite existente del CLI (`npm test`) se mantiene verde.

## 1. Resumen

Climier ya tiene un modelo útil para coordinar trabajo: `nodes`, `tasks`, `gates`, `knowledge`, `initiatives`, edges tipados y un log de actividad. El CLI es excelente para agentes y automatización, pero obliga a una persona a combinar varias salidas JSON para entender el estado completo del proyecto.

La propuesta es crear una UI local para usuarios humanos de Climier. La UI debe ser una **capa visual sobre el modelo real de Climier**, no una abstracción que cambie sus nombres o conceptos.

La experiencia principal combinará:

1. un tablero Kanban del trabajo actual;
2. un grafo DAG de dependencias;
3. un panel de detalle para cada node;
4. comentarios, referencias, knowledge e historial;
5. una explicación visible del flujo que siguen los agentes.

La UI no es una consola exclusiva del orquestador. Su propósito es que una persona pueda entender qué está pasando en su proyecto y, al mismo tiempo, familiarizarse con el vocabulario y el protocolo de Climier.

> Si el usuario es el usuario final de la aplicación Vegsport, esta UI no debe exponerse dentro de Vegsport. Los nodos Climier contienen información interna de desarrollo, arquitectura, seguridad, agentes y worktrees. En ese caso debe existir una UI de progreso del producto separada.

## 2. Observaciones del uso real en Vegsport

La inspección de `~/Dev/vegsport` mostró que Climier se usa como capa de coordinación de agentes, no como funcionalidad runtime de la aplicación.

El flujo documentado es:

```text
status → context → take → work → add-note → resolve
```

También aparecen:

- worktrees aislados por task;
- notas de workers con evidencia de implementación;
- notas de validators con `PASS` o `BLOCKED`;
- gates revisadas por varios perfiles (`arquitectura`, `producto`, `ejecución`);
- `reopen`, `release` y `cancel` para recuperación;
- knowledge asociado por initiative o domain;
- decisiones y RFCs referenciadas desde `body` y notas.

En la fotografía consultada había aproximadamente:

- 209 nodos;
- 179 tasks;
- 21 gates;
- 9 knowledge nodes;
- 14 initiatives;
- 151 tasks `done`;
- 26 tasks `canceled`;
- 2 tasks en `backlog`;
- 18 gates `resolved`;
- 2 nodes `superseded`;
- 1 gate `open`;
- 8 knowledge activos y 1 deprecated;
- más de 1.300 eventos en el log;
- más de 600 eventos `add-note`.

El estado es dinámico y estos números son sólo una observación puntual.

Hallazgos relevantes para la UI:

- El tablero activo puede estar casi vacío aunque exista mucho historial. Por eso el historial no puede ser una pantalla secundaria inexistente.
- Las notas son parte importante del sistema de coordinación: no son solamente comentarios informales.
- Las referencias estructuradas (`refs`) todavía se usan poco en Vegsport; muchos documentos se mencionan dentro de `body` o notas.
- Las tareas pequeñas también pueden ejecutarse fuera de Climier mediante el direct lane. La UI debe declarar que representa el trabajo registrado en Climier, no necesariamente todo el trabajo del repositorio.
- En el modelo actual, `ready` y `blocked` son estados derivados del DAG. No deben tratarse como valores que el usuario pueda editar libremente.

## 3. Objetivos

### Objetivo principal

Permitir que una persona responda sin abrir varias terminales:

- ¿Qué nodes existen?
- ¿Qué puedo hacer ahora?
- ¿Qué está bloqueado?
- ¿Por qué está bloqueado?
- ¿Qué gate o task lo desbloquea?
- ¿Qué conocimiento y referencias aplican?
- ¿Qué hizo el agente?
- ¿Qué evidencia demuestra que terminó?

### Objetivos secundarios

- Familiarizar al usuario con el modelo de Climier.
- Hacer visibles las relaciones del DAG sin ocultar su semántica.
- Mostrar comentarios y actividad sin convertir el tablero en un log ilegible.
- Permitir acciones válidas de Climier desde la UI en una fase posterior.
- Mantener el CLI como fuente de verdad y la UI como proyección.

## 4. Principios de producto

### 4.1 Mantener el vocabulario de Climier

No se cambiarán los nombres canónicos por nombres genéricos. La interfaz usará:

- `Node`;
- `Task`;
- `Gate`;
- `Knowledge`;
- `Initiative`;
- `BLOCKS`;
- `SUPERSEDES`;
- `DERIVED_FROM`;
- `ready`, `in_progress`, `blocked`, `backlog`, `done`, `resolved`, `canceled`, `superseded`, `active` y `deprecated`.

Cada término tendrá una explicación breve. La UI debe enseñar Climier, no esconderlo.

Ejemplo:

```text
GATE · OPEN
Decisión, aprobación, dependencia externa o investigación pendiente.
Puede bloquear otras tasks mediante un edge BLOCKS.
```

### 4.2 Explicar, no traducir

El término original aparece primero y la explicación humana aparece debajo o en un tooltip.

```text
Derived status: blocked
Este estado se calcula porque G-auth-1 todavía está open.
```

### 4.3 Proyección fiel del estado

La UI no debe inventar estados ni permitir movimientos que el modelo de Climier no permite. Un botón debe ejecutar una acción real (`take`, `resolve`, `release`, `reopen`, `cancel`, `add-note`, etc.).

### 4.4 Progresive disclosure

La pantalla inicial debe ser comprensible. Los detalles técnicos —revision, agentes, worktrees, raw log y comandos— deben estar disponibles sin dominar la experiencia.

### 4.5 El contexto es más importante que la decoración

El valor principal no es dibujar muchas tarjetas. Es explicar dependencias, decisiones, conocimiento, evidencia y actividad.

## 5. Modelo visible

### 5.1 Node

Todo elemento del DAG es un `node`. Sus tipos principales son:

- `resolvable/task`;
- `resolvable/gate`;
- `knowledge`.

### 5.2 Task

Unidad de trabajo ejecutable por un agente o una persona.

Campos relevantes para la UI:

- `id`;
- `title`;
- `body`;
- `definition`;
- `acceptance`;
- `initiative`;
- `domain`;
- `tags`;
- `claim`;
- `notes`;
- `revision`;
- `status` derivado y persistido.

### 5.3 Gate

Decision, approval, external dependency o research gate.

Campos relevantes:

- `purpose`;
- `status` (`open`, `resolved`, `superseded`, `canceled`);
- `resolution.choice`;
- `resolution.rationale`;
- `notes`;
- dependencias `BLOCKS`.

### 5.4 Knowledge

Conocimiento durable que se muestra como contexto aplicable, no como trabajo ejecutable.

La UI debe mostrar:

- `knowledge_type`;
- `body`;
- `mitigation`;
- `scope`;
- status `active` o `deprecated`;
- por qué aplica al node (`node_id`, `domain`, `tag` o `initiative`).

### 5.5 Initiative

Agrupación de trabajo. Se usará como filtro principal y como agrupación visual del grafo.

### 5.6 Edges

La UI debe mostrar el tipo y la dirección de cada relación:

- `BLOCKS`: `from` bloquea a `to`;
- `SUPERSEDES`: el node nuevo reemplaza al anterior;
- `DERIVED_FROM`: el node nuevo deriva de otro node.

La dirección de `BLOCKS` debe estar visible para evitar invertir la interpretación.

## 6. Arquitectura de navegación

```text
Overview
├── Board
├── Nodes
├── Gates
├── Knowledge
└── Activity / Log
```

El panel de detalle de un node debe ser reutilizable desde todas las vistas.

## 7. Overview

La pantalla inicial mostrará una fotografía del proyecto registrado en Climier:

- resumen de `ready`, `in_progress`, `blocked` y `backlog`;
- gates abiertas;
- knowledge activo;
- actividad reciente;
- resumen por initiative;
- claims stale;
- nodes superseded;
- dependencias canceladas que requieran revisión;
- aviso si el proyecto tiene poco o ningún trabajo activo.

El resumen debe indicar que sólo representa el trabajo registrado en Climier.

## 8. Board / Kanban

### Columnas

La vista principal usará los estados reales:

- `ready`;
- `in_progress`;
- `blocked`;
- `backlog`;
- `done` como vista opcional o sección colapsada.

`canceled`, `resolved`, `superseded` y `deprecated` se mostrarán mediante filtros históricos, no mezclados con el trabajo activo.

Las gates pueden aparecer en una fila separada llamada `Gates`, porque no tienen el mismo ciclo de claim que una task.

Knowledge no será una columna del Kanban. Se mostrará en el panel de contexto o en su propia vista.

### Tarjeta de task

Una tarjeta debe mostrar únicamente información útil para decidir qué abrir:

```text
T-pg-f1-contract-types
TASK · DONE
Definir tipos canónicos de programa/listado/sesión

Initiative: postgraduate-supabase-migration
Domain: postgrado
Notes: 7
Refs: 0
Dependents: 5
Last activity: add-note
```

Para tasks activas, la tarjeta debe destacar:

- claim actual;
- número de blockers;
- número de dependents;
- cantidad de notes;
- última actividad;
- stale claim si aplica.

La UI no debe mostrar `priority`, `effort` o `skills` como campos de primera clase mientras no formen parte estable del modelo.

### Interacción

No se permitirá arrastrar libremente una tarjeta entre columnas. Las acciones disponibles dependerán del estado real y de los permisos:

- `Take`;
- `Add note`;
- `Release`;
- `Resolve`;
- `Reopen`;
- `Cancel`;
- `Update` cuando corresponda.

Un modo avanzado puede mostrar el comando equivalente:

```bash
climier take T-auth-7 --as pi-worker
```

## 9. Panel de detalle del node

El panel lateral o página de detalle tendrá estas secciones:

### Node

- id;
- kind/subkind;
- title;
- initiative;
- domain;
- tags;
- status persistido;
- `derived_status`;
- revision;
- claim y agente actual.

### Specification

- body;
- definition;
- acceptance;
- resolution o rationale para gates.

### Blocking

Lista de blockers con:

- id;
- tipo;
- título;
- status;
- `satisfied`;
- enlace directo al node.

### Dependents

Tasks o gates que dependen de este node y el efecto de resolverlo.

### Knowledge

Knowledge aplicable, ordenado por especificidad del scope, indicando por qué aplica.

### Notes

Thread append-only con:

- texto;
- agente/persona;
- timestamp;
- filtros por tipo de actividad;
- enlaces y paths detectados.

La UI muestra las notes como texto libre y no depende de convenciones de agentes para lógica crítica. A futuro conviene agregar metadata estructurada a las notes.

### History

Historial del node usando `history <id>`:

- add-node;
- take;
- resolve;
- release;
- reopen;
- cancel;
- update;
- add-note;
- supersede.

Debe existir una vista resumida y un modo raw para aprender cómo opera el CLI.

### Refs

Mostrar `refs` estructuradas cuando existan y detectar referencias a:

- `.decisions/`;
- `.adrs/`;
- `docs/`;
- archivos del proyecto;
- URLs externas.

Las referencias detectadas automáticamente deben distinguirse de las referencias persistidas en `refs`.

## 10. Familiarización con agentes y Climier

La UI debe enseñar el protocolo, no sólo mostrar datos.

### Flujo visible

```text
context → take → work → add-note → resolve
```

Cada paso tendrá una explicación:

- `context`: leer specification, blockers y knowledge;
- `take`: reclamar una task ready;
- `work`: implementar fuera de Climier;
- `add-note`: dejar evidencia o pedir ayuda;
- `resolve`: cerrar con una nota verificable.

### Roles

Los agentes y roles se mostrarán en notes y claims. `orchestrator`, `climier-worker`, `climier-validator` y reviewers deben conservar su nombre real.

La información de worktree, branch y commit se puede mostrar en una sección técnica colapsada, no eliminarla.

### Glosario contextual

Cada término importante tendrá un tooltip o enlace a documentación:

- `derived status`;
- `claim`;
- `revision`;
- `stale claim`;
- `superseded`;
- `BLOCKS`;
- `Knowledge scope`.

## 11. Comentarios, referencias y actividad

La UI tendrá tres niveles de actividad:

1. **Última actividad en la tarjeta:** una línea o timestamp.
2. **Thread de notes del node:** comentarios y evidencia contextual.
3. **Activity / Log global:** historial de todo el proyecto con filtros por agent, action, node e initiative.

No se debe mostrar todo el log en el tablero. El log debe tener:

- paginación o carga incremental;
- filtros;
- búsqueda;
- agrupación por node;
- links a la pantalla de detalle.

## 12. Arquitectura técnica propuesta

### 13.1 UI local

Implementado: `climier ui --project <dir>` arranca el server Express local (`ui/server/server.mjs`) y abre la página (`ui/dist` generado por Vite; frontend Solid + Tailwind en `ui/src/`).

- El server escucha en `127.0.0.1` por defecto.
- Lecturas: `GET /api/snapshot`, `GET /api/node/:id`, `GET /api/activity`, `GET /api/search`. El server es el único lector del state file (importa `readState` y las funciones puras de derivación del propio CLI).
- Mutaciones (futuras, en backlog): mediante los comandos de Climier o funciones que respeten `withLock`, `updateState` y `append`.
- El estado permanece en `CLIMIER_HOME`.

Una UI remota requeriría resolver autenticación, almacenamiento compartido, control de acceso y exposición segura de notas. No forma parte del MVP.

### 13.2 Snapshot de lectura

Implementado como endpoint del server (`GET /api/snapshot`), no como comando CLI. Shape real:

```js
{
  project: { root, state_file, initialized, project_id },
  generated_at,
  initiatives: {},
  nodes: {},
  edges: [],
  derived: { ready: [], blocked: [], backlog: [], openGates: [] },
  last_activity: { "T-1": { action, agent, ts, note } },
  summary: {},
  alerts: [],
  recent_activity: []
}
```

El snapshot conserva los campos originales y agrega sólo campos derivados claramente identificados (`derived`, `last_activity`, `summary`, `alerts`). La derivación reutiliza las funciones puras del CLI (`deriveV2`, `knowledgeForNode`, `blockingForNode`) para no duplicar lógica.

### 13.3 Actualizaciones en vivo

Como las mutaciones escriben mediante archivos temporales y rename atómico, la implementación debe observar el directorio del state file o usar polling con debounce. La UI debe refrescar el snapshot completo o la parte afectada después de una mutación.

### 13.4 Concurrencia

Toda mutación desde la UI debe:

- pasar por el lock de Climier;
- dejar un evento en el log;
- respetar ownership y permisos;
- usar `revision` y `--if-revision` cuando aplique;
- mostrar un conflicto claramente si otro agente modificó el node.

## 13. Seguridad y privacidad

- No exponer el state file directamente al browser.
- No iniciar el servidor en una interfaz pública por defecto.
- Sanitizar Markdown y HTML de bodies y notes.
- Validar paths antes de abrir archivos referenciados.
- Diferenciar claramente documentación pública de paths internos.
- No exponer la UI Climier dentro de la aplicación pública Vegsport.
- Ocultar contenido sensible en una eventual modalidad remota mediante permisos por initiative/node.

## 14. Roadmap

### MVP: lectura y aprendizaje — IMPLEMENTADO (sin testing por decisión)

- [x] servidor/UI local (`climier ui`, Express + Solid + Tailwind en `ui/`);
- [x] Overview;
- [x] Board con `ready`, `in_progress`, `blocked`, `backlog` + fila `Gates`;
- [x] filtros por initiative, kind y status;
- [x] panel de detalle (spec, blockers, dependents, knowledge, notes, history, refs);
- [x] Nodes / Gates / Knowledge / Activity con filtros y paginación;
- [x] glosario contextual vía explicaciones inline;
- [x] snapshot como endpoint `/api/snapshot` (reutiliza la derivación del CLI).

### Fase 2: actividad — IMPLEMENTADO (falta search global e impacto downstream dedicado en Nodes / Gates)

### Fase 3: acciones — A BACKLOG

- `take`, `add-note`, `release`, `resolve`, `reopen`, `cancel`;
- edición segura con revision conflict;
- feedback del comando equivalente;
- identidad del humano (qué `--as` usa la UI) — pendiente, depende de las acciones.

### Fase 4: colaboración avanzada — A BACKLOG

- actualizaciones en vivo;
- worktree y validator metadata estructurada;
- notes con tipos y severidad estructurados;
- permisos para múltiples usuarios;
- modalidad remota, si existe una necesidad real.

## 15. No objetivos

- No reemplazar el modelo de Climier.
- No renombrar `tasks`, `gates`, `knowledge`, `initiatives` o edges.
- No convertir `ready` o `blocked` en estados editables manualmente.
- No construir un Trello genérico independiente del DAG.
- No exponer work interno de Climier al usuario final de Vegsport.
- No modificar directamente `tasks.json` desde la UI.
- No hacer que un resumen generado por IA reemplace los datos originales.
- No soportar inicialmente un dashboard remoto multiusuario.

## 16. Criterios de aceptación

### Vocabulario y modelo

- La UI muestra los nombres originales de Climier.
- Cada kind, status y edge tiene una explicación contextual.
- La dirección de `BLOCKS` se representa correctamente como blocker → blocked.
- `derived_status` se diferencia del status persistido.

### Board

- Los buckets del board coinciden con `status` y `context` del CLI.
- Una task bloqueada muestra sus blockers no satisfechos.
- Una task backlog no aparece como ready.
- Done, canceled y superseded pueden consultarse sin contaminar el board activo.
- No existe drag-and-drop que cree estados inválidos.

### Detalle y trazabilidad

- Un usuario puede abrir un node y ver specification, blockers, dependents, knowledge, notes, refs e history.
- Las notes conservan agente y timestamp.
- Las acciones históricas enlazan al node correspondiente.
- Las referencias persistidas se distinguen de las referencias detectadas en texto.

### Integridad

- Las lecturas de la UI coinciden con el snapshot/CLI.
- Las mutaciones pasan por el lock y generan log.
- Un conflicto de revision no sobrescribe cambios de otro agente.
- El browser nunca escribe directamente el state file.

### Aprendizaje

- Un usuario nuevo puede explicar qué significa `Gate`, `Knowledge`, `BLOCKS` y `derived status` después de usar el glosario.
- El flujo `context → take → work → add-note → resolve` está visible y documentado.
- La UI permite abrir el comando equivalente para entender cómo opera el agente.

## 17. Métricas propuestas

Estas métricas deben validarse con usuarios antes de fijarlas como contrato:

- En una prueba con escenarios reales, el usuario identifica la siguiente task y su motivo de bloqueo sin ejecutar el CLI en al menos 8 de 10 casos.
- El estado mostrado por la UI coincide con `status`/`context` en el 100% de los casos probados.
- El usuario encuentra el historial y las notes de un node sin buscar manualmente en el log global.
- El tiempo de carga local del snapshot se mantiene aceptable para proyectos de al menos 250 nodes.
- Todas las mutaciones realizadas por la UI dejan una entrada auditable en Climier.

## 18. Referencias de implementación

- `README.md`: propósito, workflow y output contract.
- `docs/reference.md`: modelo, nodes, edges, estados y comandos.
- `src/v2.mjs`: derivación de status, blockers, knowledge y edges.
- `src/commands/status.mjs`: buckets y resumen.
- `src/commands/context.mjs`: contexto de node, blockers, knowledge y allowed actions.
- `src/commands/show.mjs`: node raw.
- `src/commands/history.mjs`: historial por node.
- `src/commands/add-note.mjs`: thread de notes append-only.
- `src/storage/state.mjs`: lectura, escritura atómica y schema validation.
- `src/storage/lock.mjs`: coordinación de mutaciones concurrentes.
- `~/Dev/vegsport/AGENTS.md`: uso de Climier en el monorepo.
- `~/Dev/vegsport/CLIMIER-CHEATSHEET.md`: workflow y vocabulario usado por agents.

### Implementación de la UI (nueva)

- `ui/server/server.mjs`: server Express local, API `/api/snapshot|node|activity|search`, static de `ui/dist`.
- `ui/src/`: frontend Solid + Tailwind (vistas Overview, Board, Nodes, Gates, Knowledge, Activity, NodeDetail).
- `src/commands/ui.mjs`: comando `climier ui` (deps check, build on demand, arranque y open browser).
- `src/v2.mjs` / `src/storage/state.mjs`: funciones puras reutilizadas por el server (`deriveV2`, `knowledgeForNode`, `blockingForNode`, `readState`).
