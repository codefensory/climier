# RFC: API V2 de acciones core para plugins

- Gate: `G-plugin-v2-rfc` · Iniciativa: `plugin-platform` · Estado: borrador
- Autor: orchestrator · Fecha: 2026-08-26
- Origen: promoción de `T-plugin-v2-rfc-backlog` tras completar el host V1.

## Problema

V1 permite instalar un paquete, despachar comandos namespaced, consultar el estado y guardar datos aislados del plugin. Deliberadamente no permite mutar entidades core: no puede crear una task desde un hallazgo, aplicar un plan como DAG, sincronizar un issue externo ni añadir una nota o dependencia.

Los comandos core encapsulan sus propias validaciones de schema, lifecycle, ownership, DAG, lock y log. El lock de proyecto no es reentrante; por tanto, exponer al handler una forma de invocar comandos CLI o de escribir `tasks.json` directamente rompería la atomicidad y puede bloquearse al intentar tomar el lock por segunda vez.

La necesidad de producto es una capacidad general, no un endpoint hecho a medida para un plugin: autores de `spec-to-dag`, auditoría con remediaciones, sincronización externa, triage e incident response deben poder solicitar mutaciones core bajo las mismas invariantes que el CLI.

## Propuesta

### API declarativa de acciones, no un shell del CLI

V2 añade `api.core.run(batch)` al API V1. No acepta argv, nombres de comandos CLI ni callbacks ejecutables. Recibe una lista declarativa, tipada y versionada de operaciones; toda llamada es atómica:

```js
const result = await api.core.run({
  operations: [
    {
      op: "task.create",
      input: {
        id: "T-incident-contain",
        initiative: "incident-42",
        title: "Contain the incident",
        body: "...",
        acceptance: "...",
        blocked_by: ["G-incident-scope"],
        tags: ["incident"]
      }
    },
    {
      op: "edge.add",
      input: { from: "T-incident-contain", to: "T-incident-recover", type: "BLOCKS" }
    }
  ]
});
```

Toda creación en V2 lleva `id` explícito. Así las operaciones posteriores del batch pueden referenciarla, el resultado es determinista y una repetición fallida por conflicto no deja estado parcial.

La superficie inicial es general sobre las entidades mutables del dominio, no sobre los comandos operativos del host:

| Grupo | Operaciones V2 candidatas |
|---|---|
| Iniciativas | `initiative.create` |
| Tasks | `task.create`, `task.update`, `task.take`, `task.release`, `task.resolve`, `task.reopen`, `task.cancel` |
| Gates | `gate.create`, `gate.resolve`, `gate.reopen`, `gate.cancel` |
| Knowledge | `knowledge.create`, `knowledge.deprecate` |
| Grafo y conversación | `edge.add`, `note.add` |

Cada `input` usa campos JSON del dominio, no flags del CLI. Los nombres, campos requeridos, defaults, validación de IDs, reglas `BLOCKS`, revisiones optimistas y transiciones de lifecycle son los mismos que la operación core equivalente. Crear un nodo puede incluir sus dependencias declaradas; un batch puede además crear edges explícitos.

Quedan excluidos `init`, `install`, `uninstall`, `restore`, snapshots y cualquier operación sobre el árbol global de plugins: son administración del host, no acciones de proyecto para extensiones.

### Capabilities concedidas por proyecto

El descriptor V2 declara las capabilities que el plugin desea, por ejemplo:

```json
{
  "climier": {
    "id": "example.planner",
    "command": "plan",
    "entry": "./climier.mjs",
    "capabilities": ["core.task.create", "core.edge.add"]
  }
}
```

El host valida los nombres y no concede ninguna capability core por defecto. Un comando core de administración de proyecto concede o revoca únicamente capabilities declaradas para ese plugin. Los grants se guardan como metadata opcional y administrada por el host dentro de `state.plugins[pluginId]`, separada de `data`; por ello se aplican por proyecto y se preservan igual que los datos V1.

Cada operación exige su capability exacta. Las identidades reservadas `orchestrator` y `recovery` no pueden entrar por `api.core`; las reglas de claim/owner se evalúan contra `api.runtime.agent`, tal como en el CLI normal. Este mecanismo expresa consentimiento, mínimo privilegio y trazabilidad para la API soportada; no es un sandbox contra un paquete malicioso que ya se ejecuta con permisos del usuario.

### Transacción, locks y logs

`api.core.run` exige un agente runtime no vacío y hace lo siguiente:

1. resuelve `plugin_id`, agente y grants antes de mutar;
2. toma una sola vez `withLock(projectDir)`;
3. relee el estado, aplica cada operación sobre una copia de trabajo y valida el batch completo, incluidos IDs, iniciativas, capacidades, ownership, revisiones, dependencias y ciclos;
4. si cualquier operación falla, devuelve un error estructurado y no escribe estado ni log;
5. si todas pasan, serializa el estado final y sus entradas de log en una única escritura atómica; después libera el lock y devuelve resultados por operación.

La implementación extrae servicios puros de validación y transición del dominio. Los comandos CLI y `api.core.run` usan esos servicios, pero ninguno llama al otro: así se evita tomar el lock dentro de un lock y se conserva paridad de reglas.

Se agrega una entrada de log por operación con `action: "plugin-core-action"`, `plugin_id`, agente, `batch_id`, `operation`, node objetivo y un resumen redactado de campos afectados. El log no vuelca `body`, `meta`, valores de datos ni texto de notas. El `batch_id` permite reconstruir una operación compuesta y la entrada por node mantiene `history <id>` útil.

### Errores y resultados

El API devuelve resultados normalizados en el orden del batch, con entidades creadas o revisiones finales cuando aplique. Errores de forma, capability y batch usan envelopes `PLUGIN_*` para que el dispatcher no los envuelva como fallo opaco del handler:

- `PLUGIN_CAPABILITY_DENIED` — capability no declarada o no concedida;
- `PLUGIN_CORE_INVALID_OPERATION` — `op` o input fuera del contrato V2;
- `PLUGIN_CORE_BATCH_FAILED` — una operación válida en forma no puede aplicarse; incluye índice, `op` y causa core estructurada;
- `PLUGIN_CORE_ATOMICITY_FAILED` — fallo inesperado antes de persistir; no promete una mutación parcial.

La causa preserva el código core relevante (`ID_CONFLICT`, `NODE_NOT_FOUND`, `NOT_OWNER`, `REVISION_CONFLICT`, `CYCLE_DETECTED`, etc.) en `details.cause`; no se expone como tokens de CLI. Errores de I/O siguen la política de fallo explícito del core.

### Compatibilidad

V1 conserva exactamente `runtime`, `query` y `data`. Un descriptor sin `capabilities` sigue siendo un plugin V1 y no recibe `api.core`. Los campos de grants son aditivos bajo el namespace opcional `plugins`, no cambian lifecycle ni derivación del DAG; la decisión de schema debe verificarse contra la regla de compatibilidad de `AGENTS.md` antes de requerir un bump.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| `api.core.run(argv)` que reejecuta comandos CLI | Superficie aparentemente pequeña; reutiliza el parser | Acopla plugins a flags y defaults internos, no compone operaciones, dificulta capabilities y puede tomar locks de forma reentrante. |
| Un método ad hoc por plugin o por caso de uso | Entrega rápida para el primer autor | Multiplica APIs incompatibles y no compone planificación, triage, auditoría e integraciones. |
| Métodos JS independientes sin batch (`api.tasks.create`, etc.) | Ergonomía inicial | No resuelve atomicidad entre task, edge, nota y lifecycle; exige diseñar rollback en cada plugin. |
| **Batch declarativo de acciones con capabilities y una transacción core** | General, auditable, versionable, atómico y reutilizable por familias de plugins | Requiere extraer servicios puros de los comandos actuales y una matriz amplia de pruebas. |

## Alcance

- Dentro:
  - contrato público `api.core.run({ operations })` y catálogo versionado de operaciones core;
  - capabilities declaradas en descriptor y grants/revocations explícitos por proyecto;
  - servicios puros compartidos por CLI y API, transacción con un lock y persistencia/log atómicos;
  - identidades, ownership, errores, respuestas y logs atribuibles a plugin;
  - fixture técnico y pruebas de paridad, concurrencia, permisos y rollback.
- Fuera:
  - UI y renderizado de plugins, que siguen en `plugin-ui` / `G-plugin-ui-rfc`;
  - hooks, eventos, daemons, scheduler, reintentos o ejecución automática;
  - sandbox, firmas, secretos, registry, marketplace o aislamiento de red;
  - `api.core.run` basado en argv, eval, callbacks o acceso directo a `tasks.json`;
  - operaciones administrativas de host (`init`, install/uninstall, snapshot/restore).

## Riesgos y preguntas abiertas

- Refactorizar cada mutador a servicios puros puede revelar diferencias de comportamiento actuales entre comandos → construir pruebas de paridad antes de sustituir paths de CLI.
- Un batch grande aumenta el coste de reescribir el estado y el tiempo bajo lock → V2 debe fijar límites de cantidad de operaciones y tamaño de inputs, o rechazar explícitamente lotes excesivos; el valor exacto requiere benchmark durante el bootstrap.
- Grants por proyecto requieren una superficie de administración y revocación sin mezclar datos del plugin con metadata del host → documentar el formato, preservación, uninstall/reinstall y qué ocurre ante un descriptor que reduce capabilities.
- Resolver, cancelar o reabrir desde un plugin puede tener efectos amplios sobre agentes humanos → capabilities exactas, agente no reservado, mismas reglas de ownership y logs por operación son obligatorios; queda por decidir si algunas lifecycle operations requieren confirmación adicional de CLI.
- Las operaciones dependientes dentro de un batch necesitan una semántica clara de validación contra nodos creados previamente y de ciclos → IDs explícitos y validación sobre la copia de trabajo son la propuesta, a probar con DAGs complejos.
- Un error de escritura después de construir el estado sigue siendo un fallo de almacenamiento del host → `updateState` temp+rename debe continuar siendo la única persistencia; el diseño no promete compensar side effects externos de código de plugin.

## Verificación requerida

1. Pruebas de descriptor y grants: capability omitida, malformada, no concedida, revocada, reinstall y aislamiento entre proyectos.
2. Una prueba de paridad por operación: misma entrada y mismo estado inicial producen la misma entidad, lifecycle, validación y error core que el comando CLI correspondiente.
3. Batches de create/update/edge/note exitosos escriben un estado coherente y logs por operación con mismo `batch_id` sin volcar campos sensibles.
4. Un fallo en cada posición de un batch deja byte-equivalente el estado y no añade logs; incluye ID duplicado, iniciativa desconocida, ownership inválido, revisión obsoleta, edge inválido y ciclo.
5. Dos procesos concurrentes, uno de `api.core.run` y otro de un mutador CLI o `data.*.set`, preservan ambos cambios cuando son compatibles y serializan o rechazan limpiamente cuando no lo son; no hay timeout por lock reentrante.
6. Un plugin sin `--as` o con `--as orchestrator|recovery` no puede ejecutar acciones core.
7. El fixture V2 cubre al menos creación de task + edge, actualización, nota y un error de capability mediante el dispatcher real.
8. `npm test`, pruebas específicas de plugin y un smoke install → grant → comando V2 → history/context → revoke → rechazo.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-006: acciones core declarativas, transacción y paridad CLI → `.adrs/006-plugin-core-actions-v2.md`
- [ ] ADR-007: capabilities y grants de plugins por proyecto → `.adrs/007-plugin-capabilities-v2.md`
