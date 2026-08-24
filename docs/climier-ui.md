# Climier UI: tablero, DAG y contexto de nodos

**Estado:** propuesta de producto y diseño

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
├── Graph
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
Last activity: validator PASS
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

## 9. Graph / DAG

El grafo completo será una vista secundaria y filtrable. No se deben mostrar todos los nodes históricos de entrada.

### Layout

- Eje horizontal: profundidad de dependencia, desde blockers hacia dependents.
- Agrupación vertical: `initiative` o `domain`.
- Filtro inicial: sólo nodes activos de una initiative.
- Acción `Show history`: agrega done, canceled, resolved y superseded.
- Acción `Focus node`: muestra el node, sus blockers y sus dependents.

### Apariencia

- Task: rectángulo.
- Gate: rombo.
- Knowledge: nodo pequeño o badge contextual.
- `BLOCKS`: línea sólida naranja o roja.
- `SUPERSEDES`: línea punteada morada.
- `DERIVED_FROM`: línea punteada azul o gris.
- Done o superseded: opacidad reducida, pero no desaparecen cuando el usuario está viendo historial.

Los colores no serán el único indicador: cada node tendrá texto, icono y tipo visible.

### Herramientas del grafo

- zoom y pan;
- búsqueda por id o título;
- filtro por initiative, domain, status y kind;
- mini-map;
- mostrar sólo blockers;
- mostrar sólo dependents;
- resaltar el camino entre dos nodes;
- contador de impacto: cuántos nodes downstream dependen de un node;
- alerta para blockers cancelados o superseded.

## 10. Panel de detalle del node

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

La UI puede reconocer convenciones existentes como `[review:arquitectura]`, `[bloqueo]`, `VALIDATION PASS` y `WORKTREE`, pero no debe depender permanentemente de texto libre para lógica crítica. A futuro conviene agregar metadata estructurada a las notes.

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

## 11. Familiarización con agentes y Climier

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

## 12. Comentarios, referencias y actividad

La UI tendrá tres niveles de actividad:

1. **Última actividad en la tarjeta:** una línea o timestamp.
2. **Thread de notes del node:** comentarios y evidencia contextual.
3. **Activity / Log global:** auditoría de todo el proyecto con filtros por agent, action, node e initiative.

No se debe mostrar todo el log en el tablero. El log debe tener:

- paginación o carga incremental;
- filtros;
- búsqueda;
- agrupación por node;
- links a la pantalla de detalle.

## 13. Arquitectura técnica propuesta

### 13.1 UI local

La primera versión debería ejecutarse localmente:

```bash
climier ui --project ~/Dev/vegsport
```

La UI no debe leer o modificar `tasks.json` desde el navegador.

- Lecturas: mediante una API local o un comando de snapshot.
- Mutaciones: mediante los comandos de Climier o funciones que respeten `withLock`, `updateState` y `append`.
- El estado permanece en `CLIMIER_HOME`.
- El servidor debe escuchar en localhost por defecto.

Una UI remota requeriría resolver autenticación, almacenamiento compartido, control de acceso y exposición segura de notas. No forma parte del MVP.

### 13.2 Snapshot de lectura

Actualmente climier tiene `status`, `context`, `show`, `history` y `log`, pero no una exportación completa del grafo. La UI no debería hacer cientos de llamadas independientes para construir la pantalla.

Se propone una lectura futura como:

```bash
climier snapshot --all
```

Shape conceptual:

```js
{
  version: 2,
  project: {
    root: "...",
    project_id: "..."
  },
  generated_at: "...",
  initiatives: {},
  nodes: {},
  edges: [],
  derived: {
    "T-auth-1": {
      status: "blocked",
      blocking: [],
      dependents: [],
      knowledge: []
    }
  },
  summary: {},
  recent_activity: []
}
```

El snapshot debe conservar los campos originales y agregar sólo campos derivados claramente identificados.

### 13.3 Actualizaciones en vivo

Como las mutaciones escriben mediante archivos temporales y rename atómico, la implementación debe observar el directorio del state file o usar polling con debounce. La UI debe refrescar el snapshot completo o la parte afectada después de una mutación.

### 13.4 Concurrencia

Toda mutación desde la UI debe:

- pasar por el lock de Climier;
- dejar un evento en el log;
- respetar ownership y permisos;
- usar `revision` y `--if-revision` cuando aplique;
- mostrar un conflicto claramente si otro agente modificó el node.

## 14. Seguridad y privacidad

- No exponer el state file directamente al browser.
- No iniciar el servidor en una interfaz pública por defecto.
- Sanitizar Markdown y HTML de bodies y notes.
- Validar paths antes de abrir archivos referenciados.
- Diferenciar claramente documentación pública de paths internos.
- No exponer la UI Climier dentro de la aplicación pública Vegsport.
- Ocultar contenido sensible en una eventual modalidad remota mediante permisos por initiative/node.

## 15. Roadmap

### MVP: lectura y aprendizaje

- servidor/UI local;
- Overview;
- Board con `ready`, `in_progress`, `blocked`, `backlog`;
- filtros por initiative, kind y status;
- panel de detalle;
- blockers, dependents y knowledge;
- notes e historial;
- glosario de términos Climier;
- comando `snapshot` o equivalente interno.

### Fase 2: grafo y actividad

- DAG filtrable;
- dirección y tipos de edges;
- búsqueda global;
- Activity / Log con filtros;
- mostrar dependencias superseded o canceladas;
- vista de impacto downstream.

### Fase 3: acciones

- `take`;
- `add-note`;
- `release`;
- `resolve`;
- `reopen`;
- `cancel`;
- edición segura con revision conflict;
- feedback del comando equivalente.

### Fase 4: colaboración avanzada

- actualizaciones en vivo;
- worktree y validator metadata estructurada;
- notes con tipos y severidad estructurados;
- permisos para múltiples usuarios;
- modalidad remota, si existe una necesidad real.

## 16. No objetivos

- No reemplazar el modelo de Climier.
- No renombrar `tasks`, `gates`, `knowledge`, `initiatives` o edges.
- No convertir `ready` o `blocked` en estados editables manualmente.
- No construir un Trello genérico independiente del DAG.
- No exponer work interno de Climier al usuario final de Vegsport.
- No modificar directamente `tasks.json` desde la UI.
- No hacer que un resumen generado por IA reemplace los datos originales.
- No soportar inicialmente un dashboard remoto multiusuario.

## 17. Criterios de aceptación

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

## 18. Métricas propuestas

Estas métricas deben validarse con usuarios antes de fijarlas como contrato:

- En una prueba con escenarios reales, el usuario identifica la siguiente task y su motivo de bloqueo sin ejecutar el CLI en al menos 8 de 10 casos.
- El estado mostrado por la UI coincide con `status`/`context` en el 100% de los casos probados.
- El usuario encuentra el historial y las notes de un node sin buscar manualmente en el log global.
- El tiempo de carga local del snapshot se mantiene aceptable para proyectos de al menos 250 nodes.
- Todas las mutaciones realizadas por la UI dejan una entrada auditable en Climier.

## 19. Referencias de implementación

- `README.md`: propósito, workflow y output contract.
- `docs/reference.md`: modelo, nodes, edges, estados y comandos.
- `src/v2.mjs`: derivación de status, blockers, knowledge y edges.
- `src/commands/status.mjs`: buckets y resumen.
- `src/commands/context.mjs`: contexto de node, blockers, knowledge y allowed actions.
- `src/commands/show.mjs`: node raw.
- `src/commands/history.mjs`: historial por node.
- `src/commands/add-note.mjs`: thread de notes append-only.
- `src/state.mjs`: lectura, escritura atómica y schema validation.
- `src/lock.mjs`: coordinación de mutaciones concurrentes.
- `~/Dev/vegsport/AGENTS.md`: uso de Climier en el monorepo.
- `~/Dev/vegsport/CLIMIER-CHEATSHEET.md`: workflow y vocabulario usado por agents.
