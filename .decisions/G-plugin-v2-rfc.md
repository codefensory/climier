# RFC: API V2 de acciones core para plugins

- Gate: `G-plugin-v2-rfc` · Iniciativa: `plugin-platform` · Estado: borrador revisado
- Autor: orchestrator · Fecha: 2026-08-26
- Origen: promoción de `T-plugin-v2-rfc-backlog` tras completar el host V1.

## Problema

V1 permite instalar un paquete, despachar comandos namespaced, consultar el estado y guardar datos aislados del plugin. Deliberadamente no permite mutar entidades core: no puede crear una task desde un hallazgo, aplicar un plan como DAG, sincronizar un issue externo ni añadir una nota o dependencia.

Los comandos core ya validan schema, lifecycle, ownership, DAG, lock y log. Un plugin no puede escribir `tasks.json` directamente ni debe ejecutar argv del CLI: eso lo acoplaría al parser y permitiría que un handler intentase tomar un lock interno de forma insegura.

La necesidad es general: `spec-to-dag`, auditoría con remediaciones, sincronización externa, triage e incident response deben poder solicitar las mismas mutaciones de proyecto que una persona ejecuta mediante el CLI.

## Propuesta

### Una acción core por llamada

V2 añade `api.core.run({ op, input })` al API V1. Recibe una operación declarativa y JSON de dominio; no acepta argv, nombres de comandos CLI, callbacks ni acceso al estado crudo.

```js
const task = await api.core.run({
  op: "task.create",
  input: {
    initiative: "incident-42",
    title: "Contain the incident",
    body: "...",
    acceptance: "...",
    blocked_by: ["G-incident-scope"],
    tags: ["incident"]
  }
});

await api.core.run({
  op: "edge.add",
  input: { from: task.node.id, to: "T-incident-recover", type: "BLOCKS" }
});
```

Cada llamada ejecuta **una** acción del core. El host garantiza que esa acción individual respeta sus reglas y termina escrita o rechazada con su log bajo el lock de proyecto. No ofrece batches, rollback automático ni una transacción entre llamadas: una llamada exitosa permanece si la siguiente falla.

El autor del plugin controla la secuencia y puede decidir cómo recuperarse. No existe borrado de nodes: eliminar una task borraría historia, dependencias o trabajo humano. Una compensación, cuando sea válida, es otra acción explícita como `task.cancel`, que conserva auditoría y sigue las reglas ordinarias de ownership. Un plugin nunca puede suponer que una compensación será posible ni revertir cambios externos que haya producido.

### Superficie general V2

Todos los plugins instalados tienen acceso a `api.core`; V2 no introduce capabilities, grants, permisos por proyecto ni configuración adicional. El core sigue verificando identidad, estado, ownership y DAG de cada operación exactamente como lo hace para un humano.

| Grupo | Operaciones V2 |
|---|---|
| Iniciativas | `initiative.create` |
| Tasks | `task.create`, `task.update`, `task.take`, `task.release`, `task.resolve`, `task.reopen`, `task.cancel` |
| Gates | `gate.create`, `gate.resolve`, `gate.reopen`, `gate.cancel` |
| Knowledge | `knowledge.create`, `knowledge.deprecate` |
| Grafo y conversación | `edge.add`, `note.add` |

Cada `input` usa campos JSON equivalentes a la operación core, no flags. Por ejemplo, `task.create` recibe `initiative`, `title`, `body`, `acceptance`, `blocked_by`, `tags`, `meta` y un `id` opcional; si falta `id`, el host conserva la asignación automática existente y devuelve el node creado. Para una secuencia, el plugin usa ese ID retornado en la siguiente llamada.

No entran en la superficie `init`, `install`, `uninstall`, `restore`, snapshots ni operaciones sobre el árbol global de plugins: son administración del host, no mutaciones de proyecto para extensiones.

### Adaptador hacia los comandos existentes

`api.core.run` valida `op` e `input`, los normaliza a argumentos del dominio e invoca **un solo** handler de comando core por llamada. `api.core.run` no adquiere un lock propio: el comando adaptado conserva su `withLock → updateState → append` actual. Así no hay lock reentrante ni se obliga a refactorizar todos los comandos a una transacción común antes de entregar V2.

El adaptador no ejecuta el parser de argv. Construye los valores que cada handler ya recibe y fija `--as` al agente efectivo de `api.runtime`. Rechaza las identidades reservadas `orchestrator` y `recovery`: son escapes de recuperación del host, no identidades que un plugin pueda usar. Las mismas reglas de claim/owner aplican a `take`, `release`, `resolve`, `reopen` y `cancel`.

Cada acción deja el log que hoy produce su comando y añade `plugin_id` al entry. La atribución queda visible en `history <id>` sin guardar los valores completos de `body`, `meta` o datos de plugin. La implementación debe conservar el contrato actual de log: cambio y log ocurren dentro del mismo lock, aunque no existe una garantía de grupo entre dos llamadas distintas.

### Ejemplos de uso

**Spec-to-DAG.** Un plugin recibe un plan y llama `initiative.create` si hace falta. Luego llama `task.create` para cada pieza y usa los IDs devueltos para `edge.add`. Si la quinta creación falla, las cuatro anteriores siguen en el proyecto; el plugin devuelve sus IDs y puede dejarlo así o intentar acciones de compensación explícitas. No hay un DAG medio invisible ni rollback implícito.

**Auditoría y sincronización.** Un auditor crea una task de remediación con `task.create` y añade su evidencia con `note.add`. Un sincronizador externo actualiza una task conocida con `task.update` y después añade un enlace como nota. Cada paso conserva el log, agente y validación del core; si el sistema externo falla, no se altera retroactivamente el estado de Climier.

## Errores y resultados

Cada éxito devuelve el resultado normalizado del comando core correspondiente (`{ node }`, `{ edge }`, etc.). Errores de forma del adaptador usan `PLUGIN_CORE_INVALID_OPERATION`; un rechazo del comando core usa `PLUGIN_CORE_ACTION_FAILED` con `details.op` y la causa estructurada del core (`ID_CONFLICT`, `NODE_NOT_FOUND`, `NOT_OWNER`, `REVISION_CONFLICT`, `CYCLE_DETECTED`, etc.). Ambos son errores `PLUGIN_*`, por lo que el dispatcher los conserva sin envolverlos como un fallo opaco del handler.

Una operación desconocida se rechaza antes de mutar. El contrato se anuncia como `api.core.version === 2`; un plugin debe detectar esa versión antes de llamar a `api.core.run`, de modo que un host V1 no se interprete como compatible.

## Compatibilidad

V1 conserva exactamente `runtime`, `query` y `data`. Un host V2 agrega `api.core`; no cambia la forma opcional de `state.plugins` ni añade permisos, grants o metadata de host allí. El lifecycle y la derivación del DAG no cambian: las operaciones core reutilizan sus validaciones existentes.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| `api.core.run(argv)` que reejecuta comandos CLI | Parece una superficie pequeña | Acopla plugins a flags y defaults internos, y confunde parser, identidad y locks. |
| Un método ad hoc por plugin o por caso de uso | Entrega rápida para el primer autor | Multiplica APIs incompatibles y no sirve a autores distintos. |
| Batch atómico con capabilities y grants | Permite commits compuestos | Requiere nueva persistencia transaccional, schema de permisos y un refactor grande antes de tener valor; se difiere a V3 si un consumidor lo exige. |
| **Acción declarativa individual adaptada a un comando core** | General para tipos de plugin distintos, pequeña, trazable y reutiliza invariantes probadas | El plugin asume secuenciación y compensación; no hay todo-o-nada entre llamadas. |

## Alcance

- Dentro:
  - `api.core.version` y `api.core.run({ op, input })` para una acción core por llamada;
  - adaptadores JSON para las operaciones listadas y pruebas de paridad con los comandos core;
  - identidad efectiva, ownership, logs con `plugin_id`, errores estructurados y fixture V2;
  - documentación de secuenciación y compensación sin borrado de nodes.
- Fuera:
  - batch, `beginTransaction`, `commit`, `rollback`, savepoints, aislamiento y reintentos de transacción;
  - permisos, capabilities, grants, configuración por proyecto o sandbox;
  - UI y renderizado de plugins, que siguen en `plugin-ui` / `G-plugin-ui-rfc`;
  - hooks, eventos, daemons, scheduler, reintentos o ejecución automática;
  - `api.core.run` basado en argv, eval, callbacks o acceso directo a `tasks.json`;
  - operaciones administrativas de host (`init`, install/uninstall, snapshot/restore).

## Riesgos y preguntas abiertas

- Un plugin que intenta varias acciones puede dejar resultados parciales por diseño → debe mostrar los resultados de cada llamada y elegir explícitamente si intenta una compensación.
- `task.cancel` conserva sus reglas actuales: una task no reclamada no se puede cancelar por un agente ordinario. Un autor no debe modelar rollback como borrado; un consumidor real que necesite reversión fuerte promueve `T-plugin-v3-transactions-backlog`.
- Mapear todos los campos JSON de cada operación sin invocar el parser puede revelar diferencias entre wrappers CLI → cada adaptador requiere prueba de paridad contra su comando y errores explícitos por campos no admitidos.
- Un plugin instalado corre con permisos del usuario y V2 no agrega permisos por plugin por decisión de producto → la confianza de instalación sigue siendo responsabilidad del usuario.
- Un error de almacenamiento sigue la política de fallo explícito existente; no hay compensación de side effects externos de código de plugin.

## Verificación requerida

1. `api.core.version` existe en V2; un plugin puede detectar su ausencia en V1 sin romper su comando.
2. Cada operación listada tiene una prueba de paridad: misma entrada y estado inicial producen la misma entidad, lifecycle, validación y error core que el comando CLI equivalente.
3. El dispatcher real entrega `api.core`; una fixture crea una task, usa el ID devuelto para agregar un edge, actualiza una task y añade una nota.
4. Operación desconocida, input inválido, agente vacío, identidad reservada, ownership inválido, revisión obsoleta y ciclo devuelven su envelope `PLUGIN_CORE_*` sin mutar.
5. Dos procesos concurrentes, uno con `api.core.run` y otro con un mutador CLI o `data.*.set`, preservan los cambios compatibles y serializan o rechazan los incompatibles sin lock reentrante.
6. Logs e `history <id>` identifican `plugin_id`, agente y acción sin volcar `body`, `meta` ni valores privados.
7. Un smoke install → comando V2 con varias llamadas → `history/context` demuestra qué acciones quedaron; una falla posterior no borra ni oculta las anteriores.
8. `npm test` y las pruebas específicas de plugin pasan.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-006: acciones core individuales para plugins V2 → `.adrs/006-plugin-core-actions-v2.md`
