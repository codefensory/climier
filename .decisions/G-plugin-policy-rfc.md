# RFC: políticas, permisos y roles extensibles por plugins

- Gate: `G-plugin-policy-rfc` · Iniciativa: `plugin-platform` · Estado: en review
- Autor: usuario + agente principal · Fecha: 2026-08-27

## Problema

El core actual interpreta los valores `orchestrator` y `recovery` como autoridades especiales en `take`, `release`, `cancel`, `reopen` y `restore`. Eso acopla el lifecycle de Climier a un modelo operativo concreto, aunque `--as` conceptualmente solo debería identificar al actor.

El host de plugins V1/V2 no tiene un punto de extensión para políticas: `api.core.run()` reutiliza los handlers core y estos aplican directamente sus reglas de ownership y autoridad. Un plugin puede envolver sus propios comandos, pero no puede imponer reglas a las invocaciones directas del CLI ni a otros plugins.

## Propuesta

Separar identidad, invariantes de lifecycle y política:

1. `--as` y `CLIMIER_AGENT` siguen resolviendo un `actor_id` opaco. Climier no registra roles ni autentica al actor.
2. El core conserva invariantes técnicas y de coordinación:
   - DAG, estados válidos, locks, escrituras atómicas y logs;
   - `take` conserva el claim exclusivo y atómico;
   - una task solo puede ser resuelta por el actor que tiene su claim activo. Esta regla no depende de nombres de roles y se mantiene como invariant del lifecycle;
   - el actor que resuelve queda registrado en `done_by` y en el log.
3. Se eliminan del core las excepciones hardcodeadas para `orchestrator` y `recovery`. Si un proyecto quiere esos roles, una política los define.
4. Se agrega una capacidad opcional de política a los plugins. Un proyecto habilita una única política activa, que expone conceptualmente:

   ```js
   await policy.authorize({
     action: "task.takeover",
     actor: "alice",
     node_id: "T1",
     project_dir,
     snapshot,
   });
   // { allow: true }
   // { allow: false, reason: "..." }
   ```

   La política define roles, asignaciones y reglas. Esos conceptos no entran al schema semántico del core.
5. La evaluación ocurre en el seam común de mutación, después de resolver identidad y leer el estado actual bajo el lock, pero antes de `updateState` y del log:

   ```text
   withLock
     → readState
     → authorize
     → validar/aplicar transición core
     → updateState
     → append
   ```
6. CLI y `api.core.run()` usan exactamente el mismo camino. Un wrapper de comando no es suficiente y no será el mecanismo de enforcement.
7. El contexto entregado a la política es read-only. La política no puede llamar `api.core.run()` ni mutar datos durante `authorize`, evitando recursión y deadlocks.
8. Si el proyecto no tiene una política habilitada, no se aplican roles adicionales. Se mantienen únicamente los invariantes core definidos arriba.
9. Una denegación devuelve un error estructurado, por ejemplo `POLICY_DENIED`, sin mutar estado ni escribir un log de éxito.

### Forma del plugin y activación

El descriptor del plugin tendrá una entrada opcional para el módulo de política, separada de su namespace de comandos. El proyecto optará explícitamente por la política instalada; la forma exacta de descriptor y configuración se fijará en el ADR.

El mismo plugin puede exponer comandos para consultar o administrar sus roles, pero esos comandos no son el hook de autorización. El host carga e invoca el módulo de política directamente para las acciones core habilitadas.

### Acciones y ownership

La policy API distinguirá acciones normales de takeover, por ejemplo:

- `task.take`
- `task.takeover`
- `task.resolve`
- `task.release`
- `task.cancel`
- `task.reopen`
- `state.restore`
- `node.update`

La política puede agregar restricciones y autorizar acciones especiales definidas por el proyecto. No puede convertir una task en resoluble por alguien distinto del actor que mantiene el claim: esa regla queda fuera de los roles y dentro del lifecycle core.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener `orchestrator`/`recovery` en el core | Cambio pequeño; conserva el comportamiento actual | Acopla Climier a un workflow específico y no permite políticas extensibles |
| Envolver comandos core desde un plugin | Implementación rápida; no requiere cambios al core | Se puede evadir ejecutando el CLI o `api.core.run()` directamente |
| **Hook de política centralizado por proyecto — recomendada** | Una sola decisión aplica a CLI y API; roles y reglas viven fuera del core | Agrega un contrato de plugins en el camino crítico de mutaciones |
| Sistema de autenticación y permisos dentro de Climier | Permitiría enforcement de seguridad real | Fuera del propósito de Climier; `--as` no es una identidad autenticada y no debe convertirse en tal |

## Alcance

- Dentro:
  - convertir `--as` en identidad sin roles implícitos;
  - conservar ownership de claims para resolver tasks;
  - remover excepciones core de `orchestrator`/`recovery`;
  - contrato de policy plugin y activación por proyecto;
  - enforcement central para CLI y `api.core.run()`;
  - evaluación bajo lock, contra snapshot actual y sin reentrancia;
  - error `POLICY_DENIED`, documentación y pruebas de bypass/concurrencia.
- Fuera:
  - autenticación, firma de identidades o seguridad de sistema operativo;
  - sandboxing general de plugins;
  - múltiples políticas activas y composición de decisiones;
  - compatibilidad entre máquinas o versiones de plugins;
  - optimización de latencia o aislamiento de procesos;
  - un escape administrativo especial dentro del core.

## Riesgos y open questions

- Un plugin de política pasa a estar en el camino crítico de las mutaciones. En esta fase se acepta que un plugin habilitado que falla pueda hacer fallar la operación; no se agrega una política alternativa silenciosa.
- La política debe ejecutarse dentro del lock y no puede usar APIs mutantes. Esto evita TOCTOU, deadlocks y decisiones sobre claims obsoletos.
- `--as` sigue siendo falsificable: la política sirve para coordinación y workflow, no para autenticación. Esto debe quedar documentado en la referencia de plugins.
- El seam debe cubrir todos los entrypoints core, incluidos comandos de bajo nivel, wrappers y `api.core.run()`. Una ruta sin hook sería un bypass.
- El ownership de una task es una invariante core deliberada: solo el actor con el claim puede resolverla. Las políticas agregan reglas, pero no reemplazan esa condición.

## Backlog futuro

- **Composición de políticas:** soportar más de un policy plugin, prioridades y resolución de conflictos.
- **Portabilidad de políticas:** fijar versión/hash, detectar plugins ausentes y evitar divergencia entre máquinas o versiones del CLI.
- **Rendimiento y aislamiento:** medir el coste de ejecutar políticas bajo lock e investigar ejecución aislada, timeouts y límites cuando exista un consumidor real.

## ADRs derivados

- [ ] ADR-NNN: contrato de policy plugins y seam de autorización core → `.adrs/NNN-plugin-policy.md`
