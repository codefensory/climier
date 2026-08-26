# RFC: plugins instalables para CLI y estado

- Gate: `G-plugin-platform-rfc` · Iniciativa: `plugin-platform` · Estado: borrador
- Autor: orchestrator · Fecha: 2026-08-26

## Problema

Climier solo se amplía hoy modificando su propio código: el dispatcher de `bin/climier.mjs` carga comandos desde `src/commands/`, el lifecycle y el DAG viven en `src/v2.mjs`, y el estado v2 no reserva un namespace para extensiones. Protocolos como validator, worker y memoria de agentes existen como skills o convenciones externas; no se pueden instalar como paquetes que añadan comandos y persistan datos sin cambiar el repositorio.

El objetivo es que un autor publique un paquete npm y un usuario pueda instalarlo con `climier install <paquete o path>`. Una vez instalado, el plugin debe poder añadir comandos, consultar el proyecto, guardar datos propios por proyecto o por node, y componer operaciones existentes de Climier. La primera entrega debe ser deliberadamente pequeña: no necesita permisos, enable/disable, configuración versionada por proyecto, hooks, workers, UI ni nuevas reglas del DAG.

## Propuesta

### Modelo de uso

La instalación es global a la máquina y la disponibilidad es inmediata para todos los proyectos de esa máquina:

```bash
climier install @climier/validator
climier validator validate T-ui-1 --as validator

climier install ./plugins/agents
climier agents add claude-auth --skill auth --as orchestrator

climier uninstall @climier/validator
```

No existe `enable`, `disable`, un registry propio ni un bloque `plugins` en `.climier.json` durante esta primera versión. `install` usa npm como proceso externo contra un prefijo bajo `CLIMIER_HOME`; también acepta una ruta local que npm pueda instalar. Si npm no está disponible, el comando falla con un error estructurado y claro.

Los paquetes instalados se descubren desde ese prefijo. `uninstall` elimina el código instalado, pero conserva los datos de plugin ya guardados en los estados de proyecto. Una reinstalación del mismo package id puede volver a utilizarlos. No habrá `purge` en la primera versión.

### Forma mínima de un plugin

El `package.json` del plugin declara un namespace de CLI y un entrypoint ESM:

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
      // api es la superficie estable del host.
    }
  }
};
```

`command` registra un namespace de primer nivel. El ejemplo anterior habilita `climier validator validate T-1`. El namespace debe ser único entre comandos core y plugins instalados; una colisión hace fallar instalación o dispatch con evidencia clara. El core conserva `install` y `uninstall` como comandos reservados.

Los argumentos posteriores al namespace se entregan al plugin sin que el parser core intente validar sus flags. `--project` sigue siendo global. Un plugin que muta datos u opera comandos core usa la identidad resuelta por Climier (`--as` y luego `CLIMIER_AGENT`), igual que los comandos existentes.

### API inicial del host

La API evita que el plugin escriba archivos de estado, tome el lock o cambie `node.status` directamente. Expone tres grupos de primitivas:

```js
api.query.node(id)
api.query.context(id)
api.query.nodes(filters)
api.query.status()
api.query.history(id)

api.data.node.get(id)
api.data.node.set(id, value)
api.data.node.update(id, updater)
api.data.project.get(key)
api.data.project.set(key, value)
api.data.project.update(key, updater)

api.core.run(command, input)
```

- `query` es lectura del modelo y de sus proyecciones existentes. `context` conserva su forma agent-first: node, blockers, knowledge, claim, alerts y acciones permitidas.
- `data.node` persiste JSON propio del plugin sobre un node. Es útil para resultado de validación, links externos, deployment, review u otro contexto ligado a una task/gate/knowledge.
- `data.project` persiste JSON propio del plugin para el proyecto completo. Es útil para registros de agentes, cursores de sync, preferencias o memoria pequeña. No es global entre proyectos, no es `.climier.json`, no es un almacén de secretos y no sustituye knowledge para hechos reutilizables.
- `core.run` compone comandos core de alto nivel —por ejemplo `add-task`, `add-gate`, `add-edge`, `add-note` o `update`— mediante su validación existente y no mediante escritura raw. Hereda la identidad que invocó el comando del plugin.

Cada mutación de `data.*` o `core.run` conserva el invariante actual: `withLock` → escritura atómica → entrada de log. El host limita los datos a JSON serializable y a un presupuesto de tamaño que se definirá en ADR; no permite funciones, buffers ni referencias circulares. `update` ejecuta un updater síncrono y valida que el resultado sea JSON antes de persistirlo.

Los plugins se ejecutan como módulos ESM dentro del proceso de Climier para mantener el primer corte simple. Son código confiado por quien ejecuta `climier install`: no hay sandbox de seguridad ni sistema de permisos. El host captura errores de carga y ejecución para que el CLI conserve su contrato JSON. El plugin puede usar Node y sus propios paquetes para ejecutar tests, llamar GitHub o consultar un servicio; el host solo administra la integración con el estado de Climier.

### Persistencia y lifecycle

La extensión de estado es estructural y requiere una migración de v2 a v3. La forma propuesta es:

```json
{
  "version": 3,
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

`plugins` no introduce una segunda máquina de estados. `ready`, `blocked`, `in_progress`, `done`, `resolved` y demás lifecycle core mantienen su significado actual. Un validator puede guardar `validation.phase` y `validation.verdict`, pero no modificar cómo `deriveV2`, `take`, `resolve` o `BLOCKS` interpretan una task.

Los snapshots existentes cubren automáticamente los datos embebidos en el estado v3. Datos grandes, secretos, binarios, caches y bases de datos externas quedan fuera del alcance: el plugin debe gestionarlos fuera de `tasks.json` y no puede prometer restore atómico de esos artefactos en esta entrega.

### Ejemplo: validator sin tratamiento especial

El primer paquete de referencia debe poder implementar:

```text
climier validator validate T-1 --as validator
```

Su handler consulta contexto, persiste `validation.phase = "running"`, ejecuta sus checks, guarda resultado y usa `api.core.run("add-note", ...)` si corresponde. El resultado puede ser `pass`, `fail` o `blocked` dentro de sus propios datos. El core no contiene una regla especial para validator, no agrega `VALIDATION` como entidad y no cambia sus estados.

### Exclusiones expresas

Este RFC excluye toda modificación de UI. La proyección read-only de datos de plugin y el renderizado declarativo se investigan separadamente en `G-plugin-ui-rfc` y `.decisions/G-plugin-ui-rfc.md`.

También quedan fuera de esta primera entrega:

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
| Plugins solo como scripts que leen/escriben archivos | Casi no exige cambios al CLI | Rompe lock, atomicidad, schema, logs y compatibilidad; no integra comandos ni estado de forma segura. |
| Host amplio desde el inicio: permisos, workers, UI custom, hooks y políticas de DAG | Máxima expresividad inicial | Mucha superficie pública y riesgo de diseñar abstracciones prematuras; dificulta desarrollar y depurar el primer plugin. |
| **Host mínimo: install/uninstall, namespace de comandos, query/data/core.run; sin UI ni automatización** | Útil para validator, agentes, memoria e integraciones; conserva invariantes core; pequeño de probar y documentar | No automatiza trabajo ni altera readiness; los plugins instalados son confiados; UI queda para un RFC posterior. |

## Alcance

- Dentro:
  - schema v3 y migración de estados v2 existentes;
  - instalación/desinstalación npm bajo `CLIMIER_HOME`, descubrimiento y errores estructurados;
  - descriptor mínimo en `package.json`, carga ESM y dispatcher por namespace;
  - API `query`, `data` y `core.run` con lock, log, identidad y JSON validado;
  - pruebas unitarias, de CLI y de concurrencia para mutaciones de datos;
  - un plugin fixture para tests y un plugin validator de referencia sin cambios especiales en el core;
  - documentación de autoría, instalación y compatibilidad del plugin API v1.
- Fuera:
  - UI, server UI y assets frontend de plugins;
  - cualquier regla de `enable`, permisos, firmas, marketplace o auto-instalar plugins por proyecto;
  - hooks/eventos y background processing;
  - cambios de semántica del DAG o del lifecycle core;
  - almacenamiento grande, secretos o backup de datos externos del plugin.

## Riesgos y open questions

- Un package npm puede ejecutar código con los permisos del usuario → la instalación es una acción explícita de confianza; esta versión no afirma sandboxing. Un error del plugin debe ser capturado y emitido como JSON sin corromper el estado.
- `npm` puede no existir en una instalación Node mínima → `install` debe fallar de forma explícita, sin fallback silencioso. El host no agregará una librería npm como dependencia runtime.
- Ejecutar módulos en proceso permite que un plugin bloquee el CLI → definir timeout no es viable de forma segura in-process; el primer contrato debe documentar handlers cortos. Aislamiento por child process se evalúa solo si aparece una necesidad real.
- `core.run` debe evitar reusar el parser del bin o producir reentrancia de locks → exponer un dispatcher interno de comandos con contexto ya resuelto y pruebas de mutación/log.
- El parser actual resuelve flags antes del comando → debe refactorizarse sin alterar la compatibilidad de comandos core ni sus boolean flags.
- Los datos de plugin pueden inflar `tasks.json` → ADR debe fijar presupuesto de tamaño, validación de JSON y mensajes de error; knowledge sigue siendo el mecanismo normal para hechos durables reutilizables.
- Desinstalar conserva datos inertes → el core debe tolerar namespaces sin paquete instalado y no borrarlos; la futura UI debe indicar indisponibilidad sin inventar semántica.
- Automatizar validator tras `resolve` requiere eventos durables y retries → queda explícitamente fuera; el flujo inicial es un comando manual.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-005: instalación, descubrimiento y dispatch de plugins instalables → `.adrs/005-plugin-install-dispatch.md`
- [ ] ADR-006: schema v3 y API de datos/operaciones para plugins → `.adrs/006-plugin-state-api.md`
