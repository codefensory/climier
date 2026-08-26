# RFC: plugins instalables V1 para CLI y datos compatibles

- Gate: `G-plugin-platform-rfc` · Iniciativa: `plugin-platform` · Estado: borrador revisado
- Autor: orchestrator · Fecha: 2026-08-26
- Revisión V1: reduce la propuesta después de reviews de arquitectura, ejecución y sobreingeniería.

## Problema

Climier solo se amplía hoy modificando su código: el dispatcher de `bin/climier.mjs` carga comandos desde `src/commands/`, y el estado no ofrece un namespace estable para datos de extensiones. Protocolos como validator, worker y memoria de agentes viven como skills o convenciones externas; no se pueden instalar como paquetes que añadan comandos y persistan datos sin editar el repositorio.

El objetivo de V1 es que un autor publique un paquete npm y un usuario pueda instalarlo con `climier install <paquete o path>`. Una vez instalado, el plugin debe poder añadir comandos, consultar el proyecto y guardar JSON propio sobre un node o el proyecto. V1 debe probar el host con un validator de referencia, no diseñar desde ahora todas las formas en que un plugin podría modificar el workflow.

## Recorte explícito de V1

V1 **no** incluye `api.core.run`, `data.update`, hooks, eventos, workers, UI, permisos, enable/disable, configuración por proyecto, nuevos estados core ni reglas del DAG.

`api.core.run` y cualquier automatización que necesite crear/modificar tasks, gates o edges pasan a una RFC V2 futura. Se conserva como backlog `T-plugin-v2-rfc-backlog`; solo se promoverá cuando V1 o un segundo plugin presenten un caso concreto que no pueda resolverse con comandos propios y datos de plugin.

El recorte evita diseñar reentrancia de `withLock`, transacciones compuestas, surface de acciones core y actualizadores arbitrarios antes de tener un consumidor real. V1 conserva `data.project` porque registro de agentes y memoria pequeña son casos de uso concretos solicitados para el sistema, no especulación.

## Propuesta

### Modelo de uso

La instalación es global a la máquina y el paquete instalado queda disponible para todos sus proyectos:

```bash
climier install @climier/validator
climier validator validate T-ui-1 --as validator

climier install ./plugins/agents
climier agents add claude-auth --skill auth --as orchestrator

climier uninstall @climier/validator
```

No existe `enable`, `disable`, registry propio ni configuración de plugins en `.climier.json` durante V1. `install` usa npm como proceso externo contra un prefijo bajo `CLIMIER_HOME`; acepta una ruta local que npm pueda instalar. Si npm no está disponible, devuelve un error estructurado; el core no agrega una librería npm como dependencia runtime.

`install` y `uninstall` usan un lock global bajo `CLIMIER_HOME/plugins` porque su prefijo es compartido por todos los proyectos de la máquina. Los paquetes se descubren desde ese prefijo. `uninstall` elimina el código instalado, pero conserva los datos de plugin ya escritos en estados de proyecto; reinstalar el mismo package id puede reutilizarlos. No habrá `purge` en V1.

### Forma mínima de un plugin

El `package.json` declara un namespace CLI y un entrypoint ESM:

```json
{
  "name": "@climier/validator",
  "version": "1.0.0",
  "type": "module",
  "climier": {
    "command": "validator",
    "entry": "./climier.mjs"
  }
}
```

El entrypoint exporta un objeto:

```js
export default {
  commands: {
    async validate({ args, api }) {
      // api es la superficie V1 del host.
    }
  }
};
```

El descriptor se lee antes de importar el entrypoint. El módulo se importa *lazy*, solo cuando se invoca su namespace; cada invocación de la CLI es un proceso nuevo, por lo que V1 no necesita cache ni invalidación entre `install`/`uninstall`.

Los namespaces core, incluidos `install` y `uninstall`, están reservados. Un descriptor ausente o inválido, un namespace que choque y un import que falle devuelven respectivamente errores estructurados `PLUGIN_INVALID_DESCRIPTOR`, `PLUGIN_NAMESPACE_CONFLICT` y `PLUGIN_LOAD_FAILED`. Los node ids no chocan con estos comandos: un id se entrega después de un comando core, por ejemplo `climier show install`.

Los argumentos posteriores al namespace se entregan al plugin sin validación de flags del parser core. `--project` se extrae como flag global y aparece en `api.runtime.project_dir`; no se entrega mezclado en `args`. Las mutaciones de datos exigen la misma identidad existente (`--as` y luego `CLIMIER_AGENT`) para preservar autoría en el log.

Un plugin es código confiado por quien ejecuta `climier install`; V1 no promete sandbox. El host convierte en JSON estructurado los errores del import y de la promesa que devuelve el handler. Trabajo en background no esperado ni errores no esperados después de que el handler termina están fuera del contrato: V1 no ofrece scheduler, timeout ni hooks.

### API V1 del host

La API no permite escribir `tasks.json`, tomar locks ni cambiar `node.status` directamente:

```js
api.runtime.project_dir

api.query.node(id)
api.query.context(id)
api.query.status(options)
api.query.history(id)

api.data.node.get(id)
api.data.node.set(id, value)
api.data.project.get(key)
api.data.project.set(key, value)
```

- `runtime.project_dir` es el root resuelto por el flag global `--project` o CWD.
- `query.node` devuelve el node raw actual. `query.context` conserva el envelope documentado del comando `context`; `query.status` y `query.history` delegan sus formas públicas existentes. La API V1 no promete subcampos que esos comandos no documenten.
- `data.node` lee/escribe el JSON del package actual sobre un node. Es adecuado para resultados de validación, links externos, deployment o review ligados a una task, gate o knowledge.
- `data.project` almacena pares key/value JSON en el namespace del package para el proyecto. Es adecuado para el registro de agentes, cursores de sync, preferencias o memoria pequeña. No es global entre proyectos, no es `.climier.json`, no es para secretos y no sustituye knowledge para hechos reutilizables.

`set` reemplaza un valor completo; no hay `update(fn)` en V1. Si dos invocaciones hacen read-modify-write sobre el mismo valor, la última escritura gana. Un caso real que necesite una actualización compuesta y atómica es evidencia para promover el RFC V2, no motivo para diseñar closures de plugin en V1.

Cada `data.*.set` es una transacción independiente: el host toma el lock de proyecto, relee estado, modifica solo `plugins[package]`, escribe atómicamente, agrega su entrada de log y libera el lock antes de resolver la promesa al plugin. El handler nunca recibe ni mantiene un lock. Por tanto no hay lock reentrante ni transacción compuesta en V1.

Los valores deben ser JSON serializable. V1 limita cada blob `data.node` a 16 KiB codificados y cada valor de `data.project` a 32 KiB; la suma de datos de un package en un proyecto no puede superar 128 KiB. Rechazos de JSON o tamaño devuelven `PLUGIN_DATA_INVALID` o `PLUGIN_DATA_TOO_LARGE` sin mutar ni loguear. Estos límites mantienen proporcional el coste actual de reescribir `tasks.json` completo en cada mutación.

### Persistencia compatible con v2

Los datos de plugin son campos **opcionales y aditivos** dentro del estado v2:

```json
{
  "version": 2,
  "initiatives": {},
  "nodes": {
    "T-1": {
      "id": "T-1",
      "status": "done",
      "plugins": {
        "@climier/validator": {
          "data": {
            "validation": {
              "phase": "finished",
              "verdict": "pass"
            }
          }
        }
      }
    }
  },
  "edges": [],
  "log": [],
  "plugins": {
    "@climier/agents": {
      "data": {
        "agents": {
          "claude-auth": { "skills": ["auth"] }
        }
      }
    }
  }
}
```

No se incrementa el schema a v3. La decisión es de compatibilidad: los campos `plugins` son opcionales, no cambian el significado de los campos v2 existentes ni son requeridos para que un binario v2 previo lea, derive o escriba tasks/gates/knowledge. Los mutadores existentes conservan campos desconocidos al releer, modificar el estado y serializarlo; una versión anterior puede ignorar datos de plugin sin reinterpretar el DAG.

La regla del proyecto queda actualizada: se incrementa la versión y se migra solo cuando un cambio elimina o reinterpreta datos existentes, hace obligatorio un campo para comportamiento correcto, cambia semántica core o impide que una CLI anterior lea y escriba con seguridad. Una extensión opcional y preservable como `plugins` no cumple esas condiciones.

Matriz V1:

| Superficie | Comportamiento con datos de plugin |
|---|---|
| `show` | Devuelve el node raw, incluido su campo opcional `plugins`. |
| `context`, `status`, `search`, `history` | Mantienen su contrato v2 y no derivan semántica desde esos datos. |
| Mutaciones core ordinarias | Preservan los namespaces `plugins` que no modifican. |
| `snapshots` y `restore` | Copian/restauran raw state, por lo que preservan los datos embebidos. |
| `init --force` | Reemplaza intencionalmente todo el estado por un proyecto vacío, incluidos datos de plugin. |
| Plugin desinstalado | Los datos permanecen raw e inertes; el core no los interpreta ni los borra. |

`plugins` no introduce una segunda máquina de estados. `ready`, `blocked`, `in_progress`, `done`, `resolved` y demás lifecycle core mantienen su significado. Un validator guarda `validation.phase` y `validation.verdict`, pero no modifica `deriveV2`, `take`, `resolve` ni `BLOCKS`.

### Plugin validator de referencia

El paquete de referencia debe implementar:

```text
climier validator validate T-1 --as validator
```

Acceptance verificable del paquete y del host:

1. Con un node existente `T-1`, el comando devuelve JSON `{ ok: true|false, task: "T-1", verdict: "pass"|"fail"|"blocked" }`.
2. Antes de ejecutar el check, persiste `validation.phase = "running"` en `nodes["T-1"].plugins["@climier/validator"].data`.
3. Al terminar, persiste `validation.phase = "finished"`, `validation.verdict` y un array JSON de checks.
4. Un check de fixture exitoso produce `verdict: "pass"`; uno fallido produce `verdict: "fail"`; evidencia ausente produce `verdict: "blocked"`.
5. No cambia `node.status`, edges, claims ni estados derivados.

El core no contiene una regla especial para validator, no agrega `VALIDATION` como entidad y no cambia sus estados.

### Secuencia de implementación posterior al ADR

Ninguna task de implementación arranca hasta que el ADR derivado esté resuelto. El orden esperado es:

1. helpers de compatibilidad v2 y persistencia `plugins`, con límites y pruebas de round-trip/concurrencia;
2. lock global, `install`/`uninstall` y discovery npm, con pruebas de instalación concurrente;
3. descriptor, loader lazy y dispatcher namespaced, con colisiones, import roto y flags globales;
4. API `query`/`data`, log e identidad, con errores JSON y datos desinstalados preservados;
5. fixture plugin y validator de referencia, con la acceptance anterior;
6. documentación de instalación y autoría.

### Exclusiones expresas

Este RFC excluye toda modificación de UI. La proyección read-only de datos de plugin y el renderizado declarativo se investigan en `G-plugin-ui-rfc` y `.decisions/G-plugin-ui-rfc.md`.

También quedan fuera de V1:

- `api.core.run`, creación/modificación de entidades core desde plugins y transacciones compuestas;
- hooks, eventos, daemons, colas y ejecución automática tras `resolve`;
- nuevos tipos de node, edge o lifecycle core;
- participación de datos de plugin en `ready`, `blocked` o satisfacción de `BLOCKS`;
- permisos, firmas, sandbox, aprobación por proyecto, enable/disable y registry propio;
- frontend arbitrario, rutas, componentes o acciones UI;
- configuración de plugin en `.climier.json`;
- secretos, artefactos grandes, sincronización remota y almacenamiento externo gestionado por el host.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Seguir agregando features al core | Contratos actuales simples; no hay loader | Cada integración requiere editar, probar y publicar Climier; validator/agentes/memoria no son reutilizables como paquetes. |
| Plugins solo como scripts que leen/escriben archivos | Casi no exige cambios al CLI | Rompe lock, atomicidad, schema y logs; no integra comandos ni datos de forma segura. |
| Host amplio desde el inicio: `core.run`, hooks, workers, UI custom y políticas de DAG | Máxima expresividad inicial | Diseña reentrancia, transacciones, eventos y superficie core antes de tener consumidor; dificulta implementar y probar el primer plugin. |
| **Host V1: install/uninstall, namespace de comandos, query y datos compatibles; sin UI ni automatización** | Prueba instalación, comandos y persistencia con validator/agentes/memoria; conserva invariantes core y es pequeño de verificar | No permite que un plugin cree/modifique entidades core ni automatiza trabajo; esas necesidades se investigan en V2 cuando existan casos reales. |

## Alcance

- Dentro:
  - campos opcionales `plugins` compatibles con schema v2, límites y pruebas de preservación;
  - instalación/desinstalación npm bajo `CLIMIER_HOME`, lock global, discovery y errores estructurados;
  - descriptor mínimo en `package.json`, carga ESM lazy y dispatcher por namespace;
  - API V1 `runtime`, `query` y `data` con lock, log, identidad y JSON validado;
  - pruebas unitarias, de CLI y de concurrencia para datos, instalación y dispatch;
  - fixture plugin y validator de referencia con acceptance verificable;
  - documentación de autoría, instalación y forma de error del plugin API V1.
- Fuera: lo enumerado en `§Exclusiones expresas`, incluido UI y el RFC V2 de operaciones core.

## Riesgos y open questions

- Un package npm puede ejecutar código con permisos del usuario → instalar es una acción explícita de confianza; V1 no afirma sandboxing.
- npm puede no existir en una instalación Node mínima → `install` falla explícitamente, sin fallback silencioso ni dependencia runtime nueva.
- Un plugin puede bloquear su propio comando → handlers deben devolver su promesa y no iniciar trabajo en background; V1 no ofrece timeout ni scheduler.
- El parser actual resuelve flags antes del comando → el dispatcher debe extraer `--project` sin cambiar el comportamiento documentado de comandos core ni sus boolean flags.
- Los datos de plugin pueden inflar `tasks.json` → V1 fija límites concretos; knowledge continúa siendo el mecanismo para hechos durables reutilizables.
- Una CLI v2 anterior puede ignorar datos de plugin → es seguro mientras se mantengan opcionales y no afecten lifecycle/DAG; un cambio que deje de cumplirlo exige bump y migración.
- Automatizar validator o ejecutar operaciones core requiere eventos/locking compuesto → ambos quedan fuera y son la razón de la entrada backlog V2.

## ADR derivado (se completa al aprobar)

- [ ] ADR-005: host de plugins V1 — instalación, dispatch, API de datos y compatibilidad v2 → `.adrs/005-plugin-host-v1.md`
