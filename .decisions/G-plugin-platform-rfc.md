# RFC: host de plugins V1 para CLI y datos compatibles

- Gate: `G-plugin-platform-rfc` · Iniciativa: `plugin-platform` · Estado: borrador revisado
- Autor: orchestrator · Fecha: 2026-08-26
- Revisión V1.1: incorpora las decisiones del usuario y la segunda ronda de reviews.

## Problema

Climier solo se amplía hoy modificando su código: el dispatcher de `bin/climier.mjs` carga comandos desde `src/commands/`, y el estado no ofrece un namespace estable para datos de extensiones. Integraciones que deberían poder evolucionar fuera del core requieren hoy editar el repositorio para añadir comandos y persistencia.

El objetivo de V1 es que un autor publique un paquete npm y un usuario pueda instalarlo con `climier install <paquete o path>`. Una vez instalado, el plugin puede añadir comandos, consultar el proyecto y guardar JSON propio sobre un node o el proyecto. V1 entrega el host y sus fixtures de prueba; no entrega validator ni ningún plugin de producto.

## Recorte explícito de V1

V1 **no** incluye `api.core.run`, `data.update`, hooks, eventos, workers, UI, permisos, enable/disable, configuración por proyecto, nuevos estados core ni reglas del DAG.

`api.core.run` y toda automatización que necesite crear o modificar tasks, gates o edges pasan a una RFC V2 futura. La entrada `T-plugin-v2-rfc-backlog` conserva ese trabajo: se promoverá solo cuando un plugin real presente un caso que no pueda resolverse con comandos propios y datos de plugin.

El recorte evita diseñar reentrancia de `withLock`, transacciones compuestas, eventos y acciones core antes de tener un consumidor real. V1 conserva `data.project` porque registro de agentes y memoria pequeña son casos de uso explícitos del sistema.

## Propuesta

### Modelo de uso e identidad

La instalación es global a la máquina y un plugin instalado queda disponible para todos sus proyectos:

```bash
climier install @example/climier-audit
climier audit check T-1 --as reviewer

climier uninstall example.audit
```

El paquete npm es solo el origen de instalación. La identidad persistida del plugin es obligatoriamente `climier.id`, no el campo npm `name`:

```json
{
  "name": "@example/climier-audit",
  "version": "1.0.0",
  "type": "module",
  "climier": {
    "id": "example.audit",
    "command": "audit",
    "entry": "./climier.mjs"
  }
}
```

- `id` debe coincidir con `^[A-Za-z0-9][A-Za-z0-9._-]*$`, es único entre los plugins instalados y se usa como key de datos y argumento de `uninstall`.
- `command` es el namespace CLI; también debe ser único y no puede coincidir con un comando core reservado.
- `entry` es la ruta ESM del paquete.

Si el descriptor no contiene `climier.id`, `install` falla con `PLUGIN_INVALID_DESCRIPTOR` y `details.field = "climier.id"`; si otro paquete ya declara ese id, falla con `PLUGIN_ID_CONFLICT`. Para reemplazar un plugin se ejecuta primero `climier uninstall <id>` y luego `climier install <origen>`.

No existe `enable`, `disable`, registry central propio ni configuración de plugins en `.climier.json`. `install` usa npm como proceso externo y acepta una ruta local que npm pueda instalar. Si npm no está disponible, devuelve un error estructurado; el core no agrega una librería npm como dependencia runtime.

Cada plugin instalado tiene un prefijo npm autocontenido en `CLIMIER_HOME/plugins/installed/<climier.id>/`; su `package.json` y el `node_modules` que npm creó conservan el descriptor y el paquete directo. No hay índice o manifest de registro adicional: discovery y `uninstall` derivan la instalación de ese directorio determinista.

`install` y `uninstall` usan un lock global bajo `CLIMIER_HOME/plugins` porque ese árbol es compartido por todos los proyectos de la máquina. Bajo el lock, `install` crea un prefijo vacío en `CLIMIER_HOME/plugins/.staging/<nonce>`, ejecuta `npm install --prefix` contra el origen y obtiene el único paquete directo del `package.json` generado por npm. Lee su descriptor, valida `id`/`command`/`entry`, importa el entrypoint y exige un export default con `commands` como objeto de funciones. Tras verificar que id y namespace no colisionen con los directorios instalados, promociona el staging mediante rename a `installed/<climier.id>`.

Si npm, descriptor, import o shape fallan, el host elimina solo el directorio de staging con `fs.rm` y devuelve `PLUGIN_INVALID_DESCRIPTOR` o `PLUGIN_LOAD_FAILED`; no ejecuta un rollback con npm ni promete revertir side effects arbitrarios del módulo importado. El lock serializa operaciones iniciadas por Climier; npm sigue siendo responsable de la consistencia interna de cada prefijo individual.

`uninstall <id>` elimina el directorio determinista `installed/<id>` y conserva los datos ya escritos en estados de proyecto. No habrá `purge` en V1. Instalar código sigue siendo una acción explícita de confianza del usuario: V1 no agrega firmas, hashes, pinning ni sandboxing.

### Forma de un plugin y dispatch

El entrypoint exporta:

```js
export default {
  commands: {
    async check({ args, api }) {
      // api es la superficie V1 del host.
    }
  }
};
```

La forma de invocación es:

```text
climier <namespace> <subcommand> [args del plugin] [--project <dir>] [--as <agent>]
```

El dispatcher vive en `bin/climier.mjs`, antes del fallback que importa `src/commands/<command>.mjs`:

1. Si el primer token no es un comando core ni un namespace instalado, conserva el error actual de comando desconocido y exit `2`.
2. Si coincide con un namespace instalado, el segundo token es el `subcommand` y se resuelve como `commands[subcommand]`.
3. El host resuelve `--project` y `--as` para sí mismo, pero entrega al handler una copia de todos los tokens de la invocación salvo namespace y subcommand, en su orden original: incluye `--project` y `--as` cuando estén presentes, incluso antes del namespace. El resto de flags, incluidos booleanos como `--force` o `--all`, llega intacto y sin validación del parser core. Los flags globales siguen reservados: los valores efectivos son `api.runtime.project_dir` y `api.runtime.agent`; los tokens reenviados no pueden alterarlos. `CLIMIER_AGENT` no es un argumento: es el fallback existente cuando no hay `--as`.
4. Una invocación de namespace válido sin subcommand o con subcommand inexistente falla con `PLUGIN_SUBCOMMAND_NOT_FOUND`, envelope estructurado y exit `1`.

Los comandos core conservan su parser y comportamiento actuales. La lista de namespaces core reservados debe vivir en un módulo único exportado y tener una prueba de unicidad contra el dispatcher; incluye los comandos existentes más `install` y `uninstall`. Un node id no choca con un namespace: por ejemplo, `climier show install` sigue siendo válido porque `install` ahí es un argumento de `show`.

El descriptor se lee e importa de forma lazy al ejecutar su namespace. Cada ejecución de CLI es un proceso nuevo, así que V1 no necesita cache ni invalidación entre `install`/`uninstall`.

El host usa el contrato JSON existente. Todo error de plugin se expresa como:

```json
{
  "ok": false,
  "error": {
    "code": "PLUGIN_HANDLER_FAILED",
    "message": "plugin audit check failed",
    "details": {
      "plugin_id": "example.audit",
      "namespace": "audit",
      "subcommand": "check"
    }
  }
}
```

con exit `1`. Los errores de descriptor, id, namespace, import y datos usan el mismo envelope estructurado. Solo el namespace completamente desconocido conserva exit `2` como el CLI actual. El host captura los errores de import y de la promesa devuelta por el handler. Trabajo en background y errores posteriores al retorno del handler quedan fuera del contrato: V1 no ofrece scheduler, timeout ni hooks.

### API V1 del host

La API no permite escribir `tasks.json`, tomar locks ni cambiar `node.status` directamente:

```js
api.runtime.project_dir
api.runtime.agent

api.query.node(id)
api.query.context(id)
api.query.status(options)
api.query.history(id)

api.data.node.get(id)
api.data.node.set(id, value)
api.data.project.get(key)
api.data.project.set(key, value)
```

- `runtime.project_dir` es el root resuelto por `--project` o CWD. `runtime.agent` es `--as` cuando existe; en su defecto, `CLIMIER_AGENT`; de no existir ambos es `null`.
- `query.*` es lectura sin lock: refleja el último estado serializado observable cuando se ejecuta la consulta. `query.context` usa `runtime.agent` para mantener el comportamiento existente de `--as`; si es `null`, conserva el contexto anónimo actual.
- `query.node` devuelve el node raw, incluidos datos de plugins que ya existan. `data.node.get`, en cambio, devuelve solo el `data` del plugin llamante para ese node; no expone el `data` de otros plugins.
- `data.node` guarda el JSON del plugin llamante sobre un node. Es adecuado para resultados, links externos, deployment o review ligados a una task, gate o knowledge.
- `data.project` almacena pares key/value JSON para el plugin llamante en ese proyecto. Es adecuado para registro de agentes, cursores de sync, preferencias o memoria pequeña. No es global entre proyectos, no es `.climier.json`, no es para secretos y no sustituye knowledge para hechos reutilizables.

`set` reemplaza un valor completo; no hay `update(fn)` en V1. Si dos invocaciones hacen read-modify-write sobre el mismo valor, la última escritura gana. Un caso real que necesite una actualización compuesta y atómica promueve el RFC V2.

Cada `data.*.set` es una transacción independiente: el host exige una identidad no vacía, toma el lock de proyecto, relee estado, modifica solo el keyspace del plugin llamante, escribe atómicamente, agrega una entrada de log sin incluir el valor completo y libera el lock antes de resolver la promesa. El handler nunca recibe ni mantiene un lock.

Los valores deben ser JSON serializable. V1 no impone límite de tamaño: el usuario administra el coste de guardar datos grandes dentro de `tasks.json`. Un valor no serializable falla con `PLUGIN_DATA_INVALID` sin mutar ni loguear.

### Persistencia compatible con v2

Los datos son campos **opcionales y aditivos** dentro del estado v2:

```json
{
  "version": 2,
  "initiatives": {},
  "nodes": {
    "T-1": {
      "id": "T-1",
      "status": "done",
      "plugins": {
        "example.audit": {
          "data": {
            "result": "pass"
          }
        }
      }
    }
  },
  "edges": [],
  "log": [],
  "plugins": {
    "example.agents": {
      "data": {
        "agents": {
          "claude-auth": { "skills": ["auth"] }
        }
      }
    }
  }
}
```

No se incrementa el schema a v3. La decisión es de compatibilidad: `plugins` es opcional, no cambia el significado de campos v2 existentes y no es requerido para que una CLI v2 previa lea, derive o escriba tasks/gates/knowledge. Los mutadores deben preservar campos desconocidos al releer, modificar el estado y serializarlo; una versión anterior puede ignorar datos de plugin sin reinterpretar el DAG.

`meta` y `nodes[id].plugins` son keyspaces disjuntos del mismo node. Bajo el lock compartido, una mutación core de `meta` preserva `plugins`, y una mutación `data.node.set` preserva `meta`; la última escritura solo puede ganar dentro del campo que modifica, nunca borra el otro keyspace.

La regla del proyecto queda actualizada: se incrementa la versión y se migra solo cuando un cambio elimina o reinterpreta datos existentes, hace obligatorio un campo para comportamiento correcto, cambia semántica core o impide que una CLI anterior lea y escriba con seguridad. Una extensión opcional y preservable como `plugins` no cumple esas condiciones.

Matriz V1:

| Superficie | Comportamiento con datos de plugin |
|---|---|
| `show` | Devuelve el node raw, incluido su campo opcional `plugins`. |
| `context`, `status`, `search`, `history` | Mantienen su contrato v2 y no derivan semántica desde esos datos. |
| Mutaciones core ordinarias | Preservan root `plugins`, `nodes[*].plugins` y los keyspaces disjuntos del node. |
| `snapshots` y `restore` | Copian/restauran raw state y preservan los datos embebidos. |
| `init --force` | Reemplaza intencionalmente todo el estado por un proyecto vacío, incluidos datos de plugin. |
| Plugin desinstalado | Los datos permanecen raw e inertes; el core no los interpreta ni los borra. |

`plugins` no introduce una segunda máquina de estados. `ready`, `blocked`, `in_progress`, `done`, `resolved` y demás lifecycle core mantienen su significado.

### Fixture y acceptance del host

V1 incluye un fixture de prueba, no un plugin de producto. El fixture declara `climier.id`, un namespace y comandos mínimos que ejercitan cada método `query.*`, `data.*` y `runtime` de V1.

Acceptance verificable del host:

1. `install` acepta un paquete/ruta con descriptor válido que incluya `climier.id`, `command` y `entry`, lo promueve desde staging al prefijo determinista del id y deja el descriptor descubrible allí. Falta de `id`, descriptor, import o shape devuelve su error estructurado, no deja directorio instalado ni staging residual y no registra un plugin.
2. El dispatcher ejecuta `climier <namespace> <subcommand>`; reenvía al plugin los tokens originales, incluidos `--project`, `--as` y booleanos propios, mientras resuelve los dos flags globales para `runtime`; rechaza subcommands desconocidos con exit `1` y mantiene exit `2` para namespaces desconocidos.
3. El fixture puede leer `runtime`, `query.node`, `query.context`, `query.status` y `query.history`, y leer/escribir `data.node` y `data.project`; las escrituras quedan namespaced, son atómicas y registran agente/acción sin volcar el valor completo al log.
4. Un handler que lanza devuelve `PLUGIN_HANDLER_FAILED` en el envelope JSON estructurado y exit `1`.
5. Datos no JSON se rechazan sin cambio de estado ni entrada de log.
6. Un estado v2 con datos root y node de plugins conserva esos datos al ejecutar `take`, `resolve`, `release`, `reopen`, `cancel`, `update`, `add-note`, `add-task`, `add-gate`, `add-knowledge`, `deprecate-knowledge`, `add-initiative`, `add-node` y `add-edge`; snapshot/restore y uninstall/reinstall del mismo `climier.id` también los preservan y la derivación DAG continúa idéntica.
7. Una prueba inicia dos procesos `climier install` del mismo fixture en paralelo, usando un stub controlado de npm para demostrar que el segundo no entra a instalar hasta que el primero libera el lock; el resultado es una instalación válida y un único segundo fallo estructurado `PLUGIN_ID_CONFLICT`, sin staging residual ni directorio incompleto.
8. Una prueba inicia en paralelo `climier update <id> --meta ...` y un comando fixture que hace `data.node.set(<id>, ...)`; ambos terminan correctamente y el node final conserva exactamente ambos keyspaces.

### Secuencia de implementación posterior al ADR

Ninguna task de implementación arranca hasta que el ADR derivado esté resuelto. Después se crean estas tasks bloqueadas por ese ADR, con acceptance extraída de la sección anterior:

1. persistencia compatible v2 y pruebas de preservación/restore;
2. lock global, instalación/desinstalación npm e identidad `climier.id`;
3. descriptor, loader lazy, namespaces reservados y dispatcher;
4. API `runtime`/`query`/`data`, identidad, log y errores;
5. fixture de tests e integración end-to-end;
6. documentación de instalación y autoría.

### Exclusiones expresas

Este RFC excluye toda modificación de UI. La proyección read-only de datos de plugin y el renderizado declarativo se investigan en `G-plugin-ui-rfc` y `.decisions/G-plugin-ui-rfc.md`.

También quedan fuera de V1:

- `api.core.run`, creación/modificación de entidades core desde plugins y transacciones compuestas;
- hooks, eventos, daemons, colas y ejecución automática tras `resolve`;
- nuevos tipos de node, edge o lifecycle core;
- participación de datos de plugin en `ready`, `blocked` o satisfacción de `BLOCKS`;
- permisos, firmas, hashes, pinning, sandbox, aprobación por proyecto, enable/disable y registry propio;
- frontend arbitrario, rutas, componentes o acciones UI;
- configuración de plugin en `.climier.json`;
- secretos, artefactos grandes, sincronización remota y almacenamiento externo gestionado por el host.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Seguir agregando features al core | Contratos actuales simples; no hay loader | Cada integración requiere editar, probar y publicar Climier. |
| Plugins solo como scripts que leen/escriben archivos | Casi no exige cambios al CLI | Rompe lock, atomicidad, schema y logs; no integra comandos ni datos de forma segura. |
| Host amplio desde el inicio: `core.run`, hooks, workers, UI custom y políticas de DAG | Máxima expresividad inicial | Diseña reentrancia, transacciones, eventos y superficie core antes de tener consumidor. |
| **Host V1: install/uninstall, id explícito, namespace de comandos, query y datos compatibles; sin UI ni automatización** | Prueba instalación, dispatch y persistencia independiente del package npm; conserva invariantes core y es pequeño de verificar | No permite que un plugin cree/modifique entidades core ni automatiza trabajo; esas necesidades se investigan en V2 cuando existan casos reales. |

## Alcance

- Dentro:
  - campos opcionales `plugins` compatibles con schema v2 y pruebas de preservación;
  - instalación/desinstalación npm bajo `CLIMIER_HOME`, lock global, identidad `climier.id`, discovery y errores estructurados;
  - descriptor mínimo en `package.json`, validación al instalar, carga ESM lazy y dispatcher por namespace;
  - API V1 `runtime`, `query` y `data` con lock, log, identidad y JSON validado;
  - fixtures y pruebas unitarias, CLI, compatibilidad, snapshot/restore y concurrencia;
  - documentación de autoría, instalación y forma de error del plugin API V1.
- Fuera: lo enumerado en `§Exclusiones expresas`, incluido UI, plugins de producto y el RFC V2 de operaciones core.

## Riesgos y open questions

- Un package npm puede ejecutar código con permisos del usuario → instalar es una acción explícita de confianza; V1 no afirma sandboxing, pinning ni protección contra sustitución maliciosa de un paquete en npm.
- npm puede no existir en una instalación Node mínima → `install` falla explícitamente, sin fallback silencioso ni dependencia runtime nueva.
- Un plugin puede bloquear su propio comando → handlers deben devolver su promesa y no iniciar trabajo en background; V1 no ofrece timeout ni scheduler.
- El dispatcher de plugin identifica y resuelve solo `--project` y `--as` como flags globales, sin cambiar el parser ni el comportamiento de comandos core; reenvía todos los tokens, incluidos esos dos y booleanos, al handler para que el autor del plugin los interprete si lo necesita.
- No hay límite de datos de plugin por decisión de producto → el usuario asume el coste de `tasks.json`; knowledge continúa siendo el mecanismo para hechos durables reutilizables.
- Una CLI v2 anterior puede ignorar datos de plugin → es seguro mientras se mantengan opcionales y no afecten lifecycle/DAG; un cambio que deje de cumplirlo exige bump y migración.
- Automatización y operaciones core requieren eventos/locking compuesto → ambos quedan fuera y son la razón de `T-plugin-v2-rfc-backlog`.

## ADR derivado (se completa al aprobar)

- [ ] ADR-005: host de plugins V1 — instalación, identidad, dispatch, API de datos y compatibilidad v2 → `.adrs/005-plugin-host-v1.md`
