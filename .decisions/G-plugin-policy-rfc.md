# RFC: políticas, permisos y roles extensibles por plugins

- Gate: `G-plugin-policy-rfc` · Iniciativa: `plugin-platform` · Estado: en review
- Autor: usuario + agente principal · Fecha: 2026-08-27

## Problema

El core actual interpreta los valores `orchestrator` y `recovery` como autoridades especiales en `take`, `release`, `cancel`, `reopen` y `restore`. Eso acopla el lifecycle de Climier a un modelo operativo concreto, aunque `--as` debería solamente identificar al actor.

El host de plugins V1/V2 no tiene un punto de extensión para políticas. `api.core.run()` reutiliza los handlers core y estos aplican directamente sus reglas de ownership y autoridad. Un plugin puede envolver sus propios comandos, pero no puede imponer reglas a las invocaciones directas del CLI ni a otros plugins.

## Decisiones fijadas para este RFC

- `--as` y `CLIMIER_AGENT` resuelven un `actor_id` opaco. No hay autenticación ni roles conocidos por el core.
- La resolución de una task sigue requiriendo que el actor tenga el claim activo. El plugin no puede reemplazar esa invariante.
- Se eliminan del core las excepciones semánticas de `orchestrator` y `recovery`.
- El takeover existe como acción interna de autorización, no como comando ni como operación pública separada.
- `--allow-unregistered-initiative` se conserva solo para callers internos y no se expone al CLI público ni a plugins.
- Los casos de tests que hoy usan `orchestrator` o `recovery` se migran a un fixture de policy; no se agrega una policy de compatibilidad permanente al producto.
- Cada handler mutante invoca el helper de policy dentro de su `withLock` existente. No se delega el enforcement a wrappers de plugins.
- Un plugin instalado globalmente puede exponer una policy que se evalúa para cualquier proyecto. El plugin decide si aplica y cómo configurarse leyendo `.climier.json`; Climier no interpreta las claves de configuración propias del plugin.
- Comandos y policy viven en el mismo entry del plugin. No se agrega un segundo archivo entry al descriptor.

## Propuesta

Separar identidad, invariantes de lifecycle y política:

1. `--as` y `CLIMIER_AGENT` continúan resolviendo un actor opaco.
2. El core conserva invariantes técnicas y de coordinación:
   - DAG, estados válidos, locks, escrituras atómicas y logs;
   - `take` conserva el claim exclusivo y atómico por defecto;
   - una task solo puede ser resuelta por el actor que tiene su claim activo;
   - el actor que resuelve queda registrado en `done_by` y en el log.
3. El core deja de comparar identidades contra strings de roles. Si un proyecto quiere roles como `orchestrator`, `recovery`, `reviewer` o `admin`, esos roles los define un plugin.
4. Se agrega una capacidad opcional de policy al entry del plugin:

   ```js
   import policy from "./policy.mjs";

   export default {
     commands: {
       roles: async (argv, api) => {
         // comando normal del plugin
       },
     },
     policy: {
       authorize: policy.authorize,
     },
   };
   ```

   Un plugin sin `policy.authorize` sigue siendo un plugin normal.
5. La policy recibe un contexto read-only, sin `api` mutante ni callbacks reentrantes:

   ```js
   await policy.authorize({
     action: "task.takeover",
     actor: "alice",
     node_id: "T1",
     project_dir,
     snapshot,
   });
   ```

   La respuesta distingue una decisión afirmativa, una denegación y, cuando el plugin no aplica al proyecto, una abstención:

   ```js
   { decision: "allow" }
   { decision: "deny", reason: "..." }
   { decision: "abstain" }
   ```
6. El host descubre los entries instalados globalmente que exponen `default.policy.authorize` y los evalúa para las mutaciones de proyecto. El plugin puede leer su configuración namespaced en `.climier.json`, por ejemplo:

   ```json
   {
     "version": 1,
     "project_id": "...",
     "team-policy": {
       "mode": "strict",
       "roles": {
         "alice": ["reviewer"]
       }
     }
   }
   ```

   Esas claves son propiedad del plugin y no forman parte del schema semántico de Climier.
7. La primera versión soporta una única policy aplicable por proyecto. Si más de un plugin instalado declara aplicabilidad para el mismo proyecto, el host falla explícitamente en vez de combinar decisiones implícitamente. La composición queda en backlog.
8. Cada handler mutante invoca el helper de policy dentro del lock que ya posee:

   ```text
   withLock
     → readState
     → clasificar la acción contra el estado actual
     → authorize
     → validar/aplicar transición core
     → updateState
     → append
   ```

   CLI y `api.core.run()` terminan en los mismos handlers y, por lo tanto, pasan por el mismo seam.
9. Una denegación devuelve `POLICY_DENIED` sin modificar estado ni escribir un log de éxito. Un fallo de carga o ejecución del plugin se informa separadamente y tampoco permite completar la mutación.

### Takeover

`takeover` ya existe como comportamiento interno en `take.mjs`: actualmente `orchestrator` puede reemplazar un claim activo y el log conserva `previous_owner`. No existe como comando ni como operación de `api.core`.

El nuevo comportamiento conserva `climier take T1` como interfaz pública. El handler calcula bajo lock:

- `task.take`: task disponible o ya reclamada por el actor;
- `task.takeover`: task reclamada por otro actor.

Solo el segundo caso consulta una policy para permitir reemplazar el claim. Si se permite, el nuevo actor pasa a ser owner y luego debe resolver la task como cualquier otro owner. Si no se permite, el resultado es `ALREADY_CLAIMED` o una denegación de policy según el contrato final.

`task.takeover` es una acción interna del policy seam; no se agrega como operación pública separada a la registry de `api.core`.

### Superficie de mutaciones

El seam debe cubrir todos los handlers mutantes de proyecto y la registry de acciones core, no solo las acciones de lifecycle. Como mínimo incluye:

```text
task.create, task.take, task.resolve, task.release, task.reopen,
task.cancel, task.update, edge.add, note.add, initiative.create,
gate.create, gate.resolve, gate.reopen, gate.cancel,
knowledge.create, knowledge.deprecate, restore
```

`--allow-unregistered-initiative` no forma parte de esta superficie: queda interno. La inclusión o exclusión de `init --force` requiere una decisión explícita del ADR porque `init` es bootstrap y actualmente no exige actor.

### Capacidad interna

`--allow-unregistered-initiative` se elimina de la superficie pública y de los inputs de plugins. Los tests, imports de recovery y herramientas internas deben invocar una capacidad interna explícita, no simularla pasando un flag público.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener `orchestrator`/`recovery` en el core | Cambio pequeño; conserva el comportamiento actual | Acopla Climier a un workflow específico |
| Envolver comandos core desde un plugin | Implementación rápida | Se puede evadir ejecutando el CLI o `api.core.run()` directamente |
| **Policy opcional en el entry global del plugin — recomendada** | Roles y reglas viven fuera del core; CLI y API comparten enforcement | Agrega código externo al camino crítico de mutaciones |
| Sistema de autenticación dentro de Climier | Permitiría seguridad real | Fuera del propósito de Climier; `--as` no es autenticación |

## Alcance

- Dentro:
  - identidad sin roles implícitos;
  - ownership del claim para resolver tasks;
  - eliminación de excepciones core de `orchestrator`/`recovery`;
  - acción interna `task.takeover`;
  - `--allow-unregistered-initiative` como capacidad interna;
  - fixture de policy para tests existentes;
  - policy opcional en el mismo entry que `commands`;
  - descubrimiento global de policies instaladas;
  - configuración namespaced leída por el propio plugin desde `.climier.json`;
  - invocación explícita por cada handler dentro de `withLock`;
  - enforcement común para CLI y `api.core.run()`;
  - errores estructurados, documentación y pruebas de bypass/concurrencia.
- Fuera:
  - autenticación, firma de identidades o seguridad del sistema operativo;
  - sandboxing general de plugins;
  - composición de múltiples policies;
  - compatibilidad entre máquinas o versiones de plugins;
  - optimización de latencia o aislamiento de procesos;
  - escape administrativo especial dentro del core;
  - decidir todavía si `init --force` forma parte de la policy surface.

## Riesgos y open questions

- Un plugin de policy pasa a estar en el camino crítico de las mutaciones. En esta fase se acepta que un plugin habilitado que falla pueda hacer fallar la operación; no se hace fallback silencioso.
- La policy se ejecuta dentro del lock y recibe un snapshot read-only. No puede usar APIs mutantes ni llamar `api.core.run()` durante `authorize`.
- `--as` sigue siendo falsificable: esto sirve para coordinación y workflow, no para autenticación. Debe quedar documentado en la referencia de plugins.
- Un plugin puede escribir directamente al filesystem si decide ignorar el contrato. El host no lo puede impedir sin sandboxing; la regla será contractual.
- `context.allowed_actions` ya contiene referencias a `orchestrator`. El ADR debe decidir si queda limitado a invariantes core o si obtiene una proyección read-only de la policy.
- Debe distinguirse una denegación (`POLICY_DENIED`) de un fallo de carga o ejecución (`POLICY_LOAD_FAILED` / `POLICY_ERROR`).
- La lista de acciones debe alinearse con los 16 entries de `api.core`, los handlers directos y `restore`; no puede quedar una mutación sin seam.
- La configuración namespaced en `.climier.json` permite que cada plugin defina su propio modelo, pero el host debe entregar siempre `project_dir` y no reinterpretar esas claves.

## Backlog futuro

- **Composición de policies:** soportar más de una policy aplicable, prioridades, abstenciones y resolución de conflictos.
- **Portabilidad de policies:** fijar versión/hash, detectar plugins ausentes y evitar divergencia entre máquinas o versiones del CLI.
- **Rendimiento y aislamiento:** medir el coste de ejecutar policies bajo lock e investigar procesos separados, timeouts y límites cuando exista un consumidor real.

## ADRs derivados

- [ ] ADR-NNN: contrato, discovery y entry único de policy plugins → `.adrs/NNN-plugin-policy-contract.md`
- [ ] ADR-NNN: seam de autorización core, takeover y remoción de roles hardcodeados → `.adrs/NNN-core-policy-seam.md`
