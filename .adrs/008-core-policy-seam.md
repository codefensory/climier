# ADR-008: seam de policy core, takeover y lifecycle

- Gate: `G-plugin-policy-seam-adr` · Iniciativa: `plugin-platform` · Estado: propuesto
- Deriva de: `G-plugin-policy-rfc`
- Requiere el contrato de: `G-plugin-policy-contract-adr`
- Fecha: 2026-08-28

## Contexto

Los handlers core aplican hoy permisos especiales basados en los strings `orchestrator` y `recovery`. También `take` permite takeover solo para `orchestrator`, `restore` verifica autoridad antes del lock y `init --force` no exige actor.

El core debe dejar de conocer roles, pero mantener invariantes de lifecycle. En particular, una task solo puede resolverse por el actor que posee su claim. Las policies de plugins deben poder agregar reglas y autorizar acciones especiales sin que un wrapper sea evadible por CLI o `api.core.run()`.

## Decisión

### Seam por handler

Cada handler mutante llama explícitamente a `authorizeAction` desde `src/policy.mjs`, dentro de su `withLock` existente:

```text
resolver actor y cargar policy aplicable
→ withLock
→ readState
→ validar target y clasificar acción
→ authorizeAction
→ aplicar invariantes core
→ updateState
→ append log
```

La selección/import de policy puede ocurrir antes del lock. La decisión no: `authorizeAction` recibe el snapshot del DAG leído bajo el lock.

El host lee `.climier.json` una vez antes del lock y pasa el objeto raw congelado. Si no existe, usa `{}`. Para `init --force`, `ensureProjectMeta` ocurre antes de seleccionar la policy; luego se lee la configuración y se entra al lock.

El snapshot no recibe APIs, funciones ni referencias mutables al state. `api.core.run()` conserva `api.runtime.agent` como actor y termina en el mismo handler que la invocación CLI.

### Invariantes core

Estas reglas no pueden ser debilitadas por un `allow` de policy:

- DAG y estados válidos;
- atomicidad, lock y logging;
- una task libre solo puede recibir un claim ganador bajo concurrencia;
- una task solo puede ser resuelta por `claim.by`;
- `done_by` registra al actor que resuelve;
- `--allow-unregistered-initiative` no es una capacidad pública ni una acción de policy.

Al eliminar los hatches de roles, `release`, `cancel` y `reopen` ya no comparan contra nombres de actores. Sin policy aplicable o con `abstain`, aplican únicamente sus precondiciones de estado. `task.resolve` mantiene el control core de owner.

### Acciones canónicas

La superficie de policy usa estas acciones:

```text
task.create
task.take
task.takeover
task.resolve
task.release
task.reopen
task.cancel
task.update
gate.create
gate.resolve
gate.reopen
gate.cancel
gate.update
knowledge.create
knowledge.deprecate
knowledge.update
initiative.create
edge.add
note.add
state.restore
state.init_force
```

`task.takeover` es interno del seam y no se agrega a la registry pública de `api.core`. `state.restore` es el nombre canónico; no se usa `restore` sin prefijo.

Aunque el registry conserve una operación pública `task.update` por compatibilidad, `update.mjs` clasifica el nodo objetivo dentro del handler, antes de `authorizeAction`, y envía `task.update`, `gate.update` o `knowledge.update`.

### Tabla de `take`

| Estado | Acción | `allow` | `deny` | `abstain` |
|---|---|---|---|---|
| task libre | `task.take` | crea claim | `POLICY_DENIED` | crea claim por default core |
| claim del mismo actor | ninguna; no hay mutación | idempotente | idempotente | idempotente |
| claim de otro actor | `task.takeover` | reemplaza claim y guarda `previous_owner` | `POLICY_DENIED` | `ALREADY_CLAIMED` |

El handler determina la acción dentro del lock sin inspeccionar nombres de roles.

### Tabla de `resolve`

1. Si no existe claim o `claim.by !== actor`, el core devuelve `NOT_OWNER` y no invoca policy para intentar debilitar esa invariante.
2. Si el actor es owner, invoca `task.resolve`.
3. `allow` o `abstain` resuelven; `deny` devuelve `POLICY_DENIED`.

Un plugin puede restringir la resolución del owner, pero nunca autorizar a un no-owner.

### `restore` e `init --force`

`restore` mueve toda decisión de autoridad dentro del lock y conserva la protección contra snapshots huérfanos:

```text
readState y validar snapshot objetivo
→ authorize("state.restore")
→ crear pre-restore snapshot
→ escribir estado restaurado
→ log
```

`init` normal es bootstrap y queda fuera del seam. `init --force` requiere `--as` o `CLIMIER_AGENT` y sigue:

```text
resolver actor
→ ensureProjectMeta si falta
→ leer projectConfig
→ withLock
→ authorize("state.init_force")
→ crear snapshot force-init
→ escribir estado nuevo
```

Esto es un breaking change para scripts actorless de `init --force` y se documenta en release notes.

### Capacidad interna

`--allow-unregistered-initiative` se elimina de `knownFlags`, help, registry e inputs de plugins. El código interno usa una función separada:

```js
addNodeInternal({
  input,
  allowUnregisteredInitiative: true,
});
```

La capacidad no se identifica con env vars, flags ocultos ni campos enviados por usuarios o plugins.

### Contexto, help y auditoría

`context.allowed_actions` deja de mencionar `orchestrator` y `recovery`. En esta versión solo muestra acciones garantizadas por invariantes core; no proyecta grants dinámicos de policy.

El help y la documentación dejan de prometer bypasses por esos strings. Las denegaciones no agregan eventos al state log en esta fase; se devuelve el error JSON correspondiente.

## Alternativas descartadas

- **Un middleware solo en `api.core`:** no cubriría invocaciones CLI directas.
- **Un wrapper de cada plugin:** permite bypass por otros plugins o comandos core.
- **Mantener ownership y roles mezclados:** impide distinguir la invariante `task.resolve` de permisos configurables.
- **Un nuevo comando `takeover`:** duplica la superficie pública; el caso sigue siendo una variante de `take`.

## Consecuencias

### Positivas

- El core no conoce roles operativos.
- Las reglas se aplican igual por CLI y API core.
- Ownership para resolver permanece explícito y estable.
- Takeover puede ser agregado por una policy sin hardcodear actores.
- Las decisiones de autorización observan el state actual bajo lock.

### Negativas

- Cada handler mutante debe mantener la llamada al seam; una nueva mutación sin ella sería un bypass.
- La policy corre en el camino crítico y comparte el lock.
- La remoción de roles mágicos rompe tests y scripts existentes.
- La distinción entre acción pública y acción interna debe mantenerse en el código y la documentación.
- Plugins pueden ignorar el contrato y escribir directamente al filesystem; no hay sandboxing.

## Plan por piezas

1. Crear `src/policy.mjs` con `authorizeAction` y el loader del ADR-007.
2. Insertar la invocación en cada handler mutante, incluido `restore` e `init --force`.
3. Eliminar comparaciones contra `orchestrator`/`recovery` y actualizar help/context/documentación.
4. Mover `--allow-unregistered-initiative` a `addNodeInternal` y eliminarlo de superficies públicas.
5. Clasificar `takeover` en `take.mjs` y updates por subkind en `update.mjs`.
6. Crear y registrar el fixture `policy-fixture`.
7. Migrar tests de roles al fixture; migrar actores nominales a `test-agent`; mover los tres casos del flag interno a `v2-internal-capabilities.test.mjs`.
8. Agregar pruebas de bypass, ownership, errores, dos takes concurrentes y policy lenta.

## Verificación

La implementación debe cumplir:

- `npm test` verde;
- `npm run test:concurrent` verde;
- policy deny no cambia state ni log de éxito;
- policy throw no cambia state;
- policy ausente/abstain aplica defaults core;
- takeover allow/deny/abstain produce los resultados de la tabla;
- un no-owner nunca resuelve aunque policy devuelva allow;
- CLI y `api.core.run()` reciben el mismo actor y pasan por el mismo seam;
- `restore` no crea pre-snapshot antes de autorizar;
- `init --force` exige actor y usa `state.init_force`;
- no existe el flag público `--allow-unregistered-initiative`;
- no quedan hatches documentados o implementados con strings `orchestrator`/`recovery`;
- una pasada de grep cubre `orchestrator`, `recovery` y `allow-unregistered-initiative`.
