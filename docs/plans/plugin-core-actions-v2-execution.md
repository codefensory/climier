# Plan de ejecución: acciones core individuales para plugins V2

Plan derivado de `.adrs/006-plugin-core-actions-v2.md` (ADR-006, aprobado).
Convierte el contrato del ADR en el DAG más pequeño que permita paralelismo
real sin solapamiento, fijando paths exclusivos, contratos compartidos,
dependencias, batches paralelos, comandos de verificación y riesgos que
invalidarían el orden. Este documento es el único entregable de
`T-plugin-core-actions-v2-bootstrap` y no crea tasks hijas en Climier.

## 1. Punto de partida observado

Inspección del repo en `main` (HEAD `a40a738 docs: approve plugin core actions ADR`)
contra los archivos ya en V1.

- `src/plugin-api.mjs` expone `createApi({ projectDir, agent, pluginId })`
  y devuelve `{ runtime, query, data }`. Falta `core` (ADR-006 §"API y
  compatibilidad"). La firma del factory es estable: cualquier task de
  implementación debe seguir aceptando esa triada sin cambios.
- `src/plugin-dispatch.mjs` resuelve `runtime` desde `originalArgv`
  (first-wins), invoca `commands[subcommand](forwardedTokens, api)` y
  propaga errores `PLUGIN_*` sin rewrapping. La cadena
  `dispatchPlugin → loadApiFactory → createApi` está cerrada: añadir
  `core` no requiere tocar `plugin-dispatch` siempre que `createApi`
  lo exponga en su retorno.
- `src/plugin-errors.mjs` define `PluginError`,
  `PluginSubcommandNotFound`, `PluginHandlerFailed`, `PluginAgentMissing`,
  `PluginInvalidDescriptor`, `PluginLoadFailed` y `isPluginError`.
  Falta el namespace `PLUGIN_CORE_*` y el wrapper central `wrapCoreError`.
- `src/log.mjs` define `append(projectDir, entry)`. ADR-006 §"Locks y
  logs" exige `appendWithContext(projectDir, entry, { pluginId })` que
  agrega `plugin_id` al entry sin tocar el log CLI normal.
- `src/commands/*.mjs` — los handlers mutadores usan
  `withLock → updateState → append` en ese orden. Los cinco del primer
  hito (`add-task`, `add-edge`, `take`, `resolve`, `add-note`) tienen
  cada uno un único `append(...)` al final del bloque con lock; los
  once restantes (`update`, `release`, `reopen`, `cancel`,
  `add-initiative`, `add-gate`, `add-knowledge`, `deprecate-knowledge`,
  y los `resolve`/`reopen`/`cancel` de gate) siguen el mismo patrón.
- `src/v2.mjs` (`statusOfV2`, `deriveV2`, `validateEdge`,
  `existingEdge`) y `src/v2-add-node.mjs` (`addV2Node`, `requireFields`,
  `hasCsvValue`) son los helpers que la registry reutiliza tal cual.
- `test/plugin-api.test.mjs`, `test/plugin-dispatch.test.mjs`,
  `test/plugin-integration.test.mjs`, `test/plugin-compat.test.mjs`,
  `test/fixtures/sample-plugin/` ya pasan en `npm test` (filtrado a
  `test/*.test.mjs` excepto `ui-*`). El helper
  `test/helpers.mjs` exige `CLIMIER_HOME` bajo `os.tmpdir()`; nunca
  toca `~/.climier`. El sandbox `.agents/skills/climier/smoke-sandbox.sh`
  está disponible para mutaciones de smoke.

## 2. Mapa de módulos/entrypoints y locks

Texto = estado actual; sufijo `(V2)` = lo que añade este plan.

```text
bin/climier.mjs                            CLI entry; sin cambios (V2)
src/commands/                              25 comandos core (V2: adaptación mínima
                                            para usar appendWithContext cuando
                                            ctx.pluginId está presente)
src/plugin-api.mjs                         createApi (V2: añade core.version + core.run)
src/plugin-core-registry.mjs               registry de op → handler + mapeo JSON (V2)
src/plugin-core-adapter.mjs                wrapCoreError + isPluginCoreError + dispatch (V2)
src/plugin-errors.mjs                      PLUGIN_CORE_* + wrapCoreError (V2)
src/log.mjs                                append + appendWithContext (V2)
src/log.mjs                                append() mantiene firma para CLI normal (V2)
src/plugin-dispatch.mjs                    sin cambios; sólo propaga el envelope
src/plugin-loader.mjs                      sin cambios
src/plugin-runtime.mjs                     sin cambios
src/plugin-query.mjs                       sin cambios
src/plugin-data.mjs                        sin cambios (ya usa plugin_id vía append)
src/state.mjs                              sin cambios; preserva plugins / nodes[*].plugins
src/lock.mjs                               sin cambios
src/agent.mjs                              sin cambios
src/errors.mjs                             sin cambios (PLUGIN_CORE_* se emite literal)
test/                                      suite existente + tests V2 (V2)
test/fixtures/sample-plugin/               fixture V1 intacta (V2: no se toca)
test/fixtures/core-plugin/                 fixture V2 (V2)
docs/PLUGINS.md                            sin cambios en este milestone (V2)
.adrs/006-plugin-core-actions-v2.md        contrato vigente (V2: referencia)
```

Locks:

| Lock | Path | Scope | Uso |
|---|---|---|---|
| `withLock(projectDir)` | `<state-dir>/.lock` | proyecto | mutadores de estado y toda llamada `api.core.run` |
| `withGlobalPluginLock` | `<CLIMIER_HOME>/plugins/.lock` | global | `install`/`uninstall` (sin cambios) |

`api.core.run` no introduce un lock nuevo: cada handler invocado
mantiene su `withLock → updateState → append`. El lock de proyecto
serializa una llamada de plugin y una llamada CLI que operen sobre el
mismo estado (verificación E2E §7).

## 3. Contratos compartidos que deben preceder consumidores

### 3.1 Errores `PLUGIN_CORE_*`

ADR-006 §"Errores": `src/plugin-errors.mjs` agrega dos clases nuevas y
un helper central, **sin** pasar por `V2_ERROR_CODES`.

```js
class PluginCoreInvalidOperation extends PluginError {
  constructor(pluginId, op, supported, reason) {
    super(
      "PLUGIN_CORE_INVALID_OPERATION",
      `plugin-core: operation '${op}' is not supported`,
      { plugin_id: pluginId, op, supported, reason },
    );
  }
}

class PluginCoreActionFailed extends PluginError {
  constructor(pluginId, op, cause) {
    super(
      "PLUGIN_CORE_ACTION_FAILED",
      `plugin-core: operation '${op}' failed: ${cause.message}`,
      { plugin_id: pluginId, op, cause },
    );
  }
}

// cause: { code, message, details } cuando el error core ya viene
// estructurado (err.code && err.details !== undefined); si no,
// { code: "CORE_ERROR", message, details: {} }.
function wrapCoreError(pluginId, op, err) {
  const cause = err && typeof err.code === "string" && err.details !== undefined
    ? { code: err.code, message: err.message, details: err.details }
    : {
        code: "CORE_ERROR",
        message: err && err.message ? err.message : String(err),
        details: {},
      };
  return new PluginCoreActionFailed(pluginId, op, cause);
}

function isPluginCoreError(err) {
  return (
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_CORE_") &&
    err.details !== undefined
  );
}
```

`isPluginError` ya cubre cualquier `PLUGIN_*` por prefijo; no requiere
cambio. `dispatchPlugin` propaga sin rewrap, así que
`PLUGIN_CORE_ACTION_FAILED` no termina como `PLUGIN_HANDLER_FAILED`
(verificación: `test/plugin-core-errors.test.mjs` y
`test/plugin-dispatch.test.mjs` extensión).

### 3.2 Registry y mapeo JSON → flags

Nuevo módulo `src/plugin-core-registry.mjs`:

```js
import addTask     from "./commands/add-task.mjs";
import addEdge     from "./commands/add-edge.mjs";
import take        from "./commands/take.mjs";
import resolveV2   from "./commands/resolve.mjs";
import addNote     from "./commands/add-note.mjs";
// (parity los suma después)

export const CORE_REGISTRY = {
  "task.create": {
    handler: addTask,
    positional: ["id"],
    required: ["initiative", "title", "body", "acceptance", "blocked-by"],
    snakeToFlag: {
      initiative: "initiative",
      title: "title",
      body: "body",
      acceptance: "acceptance",
      blocked_by: "blocked-by",
      supersedes: "supersedes",
      derived_from: "derived-from",
      domain: "domain",
      tags: "tags",
      refs: "refs",
      meta: "meta",
      backlog: "backlog",
    },
    expose: { as: false, allow_unregistered_initiative: false },
  },
  "edge.add": {
    handler: addEdge,
    positional: ["from", "to"],
    required: ["type"],
    snakeToFlag: { type: "type" },
    expose: { as: false },
  },
  "task.take":   { handler: take,      positional: ["id"],     required: [],                snakeToFlag: {}, expose: { as: false } },
  "task.resolve":{
    handler: resolveV2,
    positional: ["id"],
    required: ["note"],  // ADR: --note es flag obligatorio para task
    snakeToFlag: { note: "note" },
    expose: { as: false },
  },
  "note.add":    {
    handler: addNote,
    positional: ["id", "text"],
    required: ["text"],  // add-note espera texto como segundo posicional
    snakeToFlag: {},
    expose: { as: false },
  },
  // Parity los suma: initiative.create, task.update, task.release, task.reopen,
  // task.cancel, gate.create, gate.resolve, gate.reopen, gate.cancel,
  // knowledge.create, knowledge.deprecate.
};

export const SUPPORTED_OPS = Object.keys(CORE_REGISTRY);
```

`expose.as = false` refuerza la invariante del ADR §"Identidad": el
adaptador fija `flags.as` desde `api.runtime.agent` y rechaza cualquier
`input.as` o `input._as`. `allow_unregistered_initiative` queda fuera
del input por la misma razón.

Este módulo es consumido por:
- `src/plugin-core-adapter.mjs` (dispatch de `core.run`).
- `test/plugin-core-registry.test.mjs` (tests table-driven).

### 3.3 Seam de logs (`appendWithContext`)

Extensión mínima de `src/log.mjs`:

```js
export async function append(projectDir, entry) {
  // Firma actual intacta; comportamiento CLI normal sin cambios.
  if (!entry || typeof entry !== "object") {
    throw new Error("append: entry must be an object");
  }
  if (!entry.action) throw new Error("append: entry.action is required");
  if (!entry.agent) throw new Error("append: entry.agent is required");
  return updateState(projectDir, (s) => {
    s.log = s.log || [];
    s.log.push({ ts: new Date().toISOString(), ...entry });
    return s;
  });
}

export async function appendWithContext(projectDir, entry, ctx = {}) {
  const pluginId = ctx && typeof ctx.pluginId === "string" && ctx.pluginId.trim()
    ? ctx.pluginId.trim()
    : null;
  const enriched = pluginId ? { ...entry, plugin_id: pluginId } : { ...entry };
  return append(projectDir, enriched);
}
```

`plugin_id` nunca proviene de `input`: lo fija el adapter desde el
descriptor instalado. La llamada CLI normal sigue usando `append()`.

Adaptación de handlers (mecánica, una línea por comando):

```js
// src/commands/<x>.mjs — antes:
await append(projectDir, { agent, action: "add-task", ... });
// src/commands/<x>.mjs — después:
await appendWithContext(projectDir, { agent, action: "add-task", ... }, { pluginId: ctx.pluginId });
```

Los handlers mantienen `append` como fallback cuando
`ctx.pluginId` no viene (CLI normal). El adapter (`core.run`) inyecta
`ctx.pluginId` siempre que el descriptor del plugin esté disponible.

### 3.4 Adapter y dispatch de `core.run`

Nuevo módulo `src/plugin-core-adapter.mjs`:

```js
import { CORE_REGISTRY, SUPPORTED_OPS } from "./plugin-core-registry.mjs";
import {
  PluginCoreInvalidOperation,
  isPluginError,
  wrapCoreError,
} from "./plugin-errors.mjs";

function toCtx(pluginId, op, input) {
  const entry = CORE_REGISTRY[op];
  if (!entry) {
    throw new PluginCoreInvalidOperation(pluginId, op, SUPPORTED_OPS, "unknown operation");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginCoreInvalidOperation(pluginId, op, SUPPORTED_OPS, "input must be an object");
  }
  if ("as" in input || "_as" in input) {
    throw new PluginCoreInvalidOperation(pluginId, op, SUPPORTED_OPS, "input.as is forbidden");
  }
  const positional = entry.positional
    .map((name) => (input[name] !== undefined ? String(input[name]) : undefined))
    .filter((v) => v !== undefined);
  for (const required of entry.required) {
    // required puede ser posicional (id/text) o flag (--note/--type).
    const isFlag = entry.snakeToFlag && Object.values(entry.snakeToFlag).includes(required);
    if (isFlag) {
      const key = Object.keys(entry.snakeToFlag).find((k) => entry.snakeToFlag[k] === required);
      if (input[key] === undefined) {
        throw new PluginCoreInvalidOperation(pluginId, op, SUPPORTED_OPS, `missing required field '${key}'`);
      }
    } else if (!positional.includes(input[required])) {
      throw new PluginCoreInvalidOperation(pluginId, op, SUPPORTED_OPS, `missing required field '${required}'`);
    }
  }
  const flags = {};
  for (const [snake, kebab] of Object.entries(entry.snakeToFlag || {})) {
    if (input[snake] === undefined) continue;
    flags[kebab] = input[snake];
  }
  return { statePath: undefined, projectDir: undefined, flags, positional, pluginId };
  // statePath/projectDir los resuelve el adapter desde la factory.
}
```

El adapter en sí (parte de `createApi` o de `plugin-core-adapter.mjs`)
es:

```js
export function createCore({ projectDir, agent, pluginId }) {
  return {
    version: 2,
    async run({ op, input }) {
      let ctx;
      try {
        ctx = toCtx(pluginId, op, input);
      } catch (err) {
        // PLUGIN_CORE_INVALID_OPERATION se emite antes del lock.
        throw err;
      }
      const entry = CORE_REGISTRY[op];
      ctx.statePath = projectDir;
      ctx.projectDir = projectDir;
      try {
        return await entry.handler(ctx);
      } catch (err) {
        if (isPluginError(err)) throw err;       // PLUGIN_CORE_* / PLUGIN_* sin rewrap.
        throw wrapCoreError(pluginId, op, err);  // PLUGIN_CORE_ACTION_FAILED.
      }
    },
  };
}
```

### 3.5 Exposición en `createApi`

Modificación de `src/plugin-api.mjs` (mínima, sin romper V1):

```js
import { createCore } from "./plugin-core-adapter.mjs";

export function createApi({ projectDir, agent, pluginId }) {
  // ... validaciones V1 ...
  const core = createCore({ projectDir, agent: runtime.agent, pluginId });
  return { runtime, query, data, core };
}
```

Un host V1 (sin la importación) sigue exponiendo `{ runtime, query, data }`
sólo si no se importa `plugin-core-adapter.mjs`. En la práctica, el
módulo se importa siempre; los tests V1 verifican que
`api.core?.version === 2` cuando el módulo está disponible y
`api.core === undefined` cuando se omite el import (test
`createApi: api.core.version is 2 when registered` y
`createApi: api.core is undefined when the adapter is absent`).

## 4. Cortes de tasks con paths exclusivos

Cinco tasks, cada una con un único cambio principal, paths verificables,
no-go zones explícitas y comandos de aceptación.

### 4.1 `T-plugin-core-foundation` — Errores y registry

- **Cambio principal**: define `PLUGIN_CORE_INVALID_OPERATION`,
  `PLUGIN_CORE_ACTION_FAILED`, `wrapCoreError`, `isPluginCoreError` en
  `src/plugin-errors.mjs`; crea `src/plugin-core-registry.mjs` con el
  primer hito (cinco ops). Tests unitarios de errores y tabla.
- **Paths propios**:
  - `src/plugin-errors.mjs` (extensión; añadir las clases y el helper).
  - `src/plugin-core-registry.mjs` (nuevo).
  - `test/plugin-core-errors.test.mjs` (nuevo; cubre las dos clases, el
    wrapper, `isPluginCoreError` y la no-interacción con
    `PLUGIN_HANDLER_FAILED`).
  - `test/plugin-core-registry.test.mjs` (nuevo; tabla del primer hito:
    posicional, required, mapeo snake → flag, `expose.as = false`).
- **No-go zones**: `src/plugin-api.mjs`, `src/log.mjs`,
  `src/commands/*.mjs`, fixtures, `bin/`, docs/, .adrs/, .decisions/.
- **Acceptance**: ver §7.

### 4.2 `T-plugin-core-log-seam` — `appendWithContext` y adaptación del primer hito

- **Cambio principal**: añade `appendWithContext` a `src/log.mjs` y
  adapta los cinco handlers del primer hito para usarlo cuando
  `ctx.pluginId` está presente. Mantiene compatibilidad con la
  llamada CLI normal.
- **Paths propios**:
  - `src/log.mjs` (extensión: añadir `appendWithContext`; `append`
    intacto).
  - `src/commands/add-task.mjs`, `src/commands/add-edge.mjs`,
    `src/commands/take.mjs`, `src/commands/resolve.mjs`,
    `src/commands/add-note.mjs` (reemplazar `append` por
    `appendWithContext` con `{ pluginId: ctx.pluginId }`; el resto del
    cuerpo queda igual).
  - `test/plugin-log-seam.test.mjs` (nuevo; cubre
    `appendWithContext` con y sin `pluginId`, y verifica que los cinco
    handlers escriben `plugin_id` en el log cuando se llaman vía
    `core.run` y NO escriben `plugin_id` cuando se llaman vía CLI).
- **No-go zones**: `src/plugin-errors.mjs`,
  `src/plugin-core-registry.mjs`, `src/plugin-core-adapter.mjs`,
  `src/plugin-api.mjs`, mutadores no listados, fixtures, docs/.
- **Acceptance**: ver §7.

### 4.3 `T-plugin-core-api` — `api.core.run` y verificación del primer hito

- **Cambio principal**: extiende `createApi` con `core.version` y
  `core.run`; cablea registry, errores y log seam. Cubre el primer
  hito con tests de unidad e integración.
- **Paths propios**:
  - `src/plugin-api.mjs` (extensión: añadir `core`).
  - `src/plugin-core-adapter.mjs` (nuevo; `createCore`, `toCtx`).
  - `test/plugin-api.test.mjs` (extensión: casos
    `api.core.version === 2`, `api.core.run` con un mock handler del
    primer hito, `api.core === undefined` con factory stub que omite el
    import — opcional, sólo si la firma se mantiene).
  - `test/plugin-core-integration.test.mjs` (nuevo; flujo
    `core.version` → `task.create` → `edge.add` → `task.take` →
    `task.resolve` → `note.add` sobre un proyecto temporal, leyendo
    envelopes reales, lock de proyecto y log con `plugin_id`).
- **No-go zones**: `src/log.mjs` (sellado por la task anterior),
  `src/commands/*.mjs` (adaptados por la task anterior), registry y
  errores (sellados por la task de foundation), fixtures, docs/.
- **Acceptance**: ver §7.

### 4.4 `T-plugin-core-parity` — Adaptadores restantes y paridad

- **Cambio principal**: extiende la registry con las once ops
  restantes y adapta los handlers correspondientes para usar
  `appendWithContext` cuando `ctx.pluginId` está presente. Cubre
  parity de V1 (tests table-driven) y compatibilidad de la superficie
  V1 (no regresiones en `data.*`, `query.*`, `runtime`).
- **Paths propios**:
  - `src/plugin-core-registry.mjs` (extensión: añadir once entradas:
    `initiative.create`, `task.update`, `task.release`, `task.reopen`,
    `task.cancel`, `gate.create`, `gate.resolve`, `gate.reopen`,
    `gate.cancel`, `knowledge.create`, `knowledge.deprecate`).
  - `src/commands/update.mjs`, `release.mjs`, `reopen.mjs`,
    `cancel.mjs`, `add-initiative.mjs`, `add-gate.mjs`,
    `add-knowledge.mjs`, `deprecate-knowledge.mjs`
    (reemplazar `append` por `appendWithContext` con
    `{ pluginId: ctx.pluginId }`).
  - `test/plugin-core-registry.test.mjs` (extensión: tabla completa de
    16 ops; verifica que cada op mapea al handler correcto, traduce
    snake → flag y respeta `expose.as = false`).
  - `test/plugin-api.test.mjs` (extensión: al menos un caso por cada
    op restante para asegurar que `core.run` las ejecuta).
  - `test/plugin-compat.test.mjs` (sin cambios; sigue pasando sin
    regresión).
- **No-go zones**: `src/log.mjs`, `src/plugin-errors.mjs`,
  `src/plugin-core-adapter.mjs`, `src/plugin-api.mjs`, fixtures, docs/.
- **Acceptance**: ver §7.

### 4.5 `T-plugin-core-e2e` — Fixture V2, error smoke y child_process con CLIMIER_HOME compartido

- **Cambio principal**: crea una fixture V2 autocontenida
  (`test/fixtures/core-plugin/`), un test de integración que ejercita
  el primer hito end-to-end, un test de error smoke y un test de
  concurrencia entre procesos con `CLIMIER_HOME` compartido.
- **Paths propios**:
  - `test/fixtures/core-plugin/package.json` (nuevo; descriptor
    `climier.id = "example.core"`, `command = "core"`, sin
    dependencias runtime).
  - `test/fixtures/core-plugin/climier.mjs` (nuevo; entrypoint con un
    subcomando por op del primer hito, encadenando
    `task.create → edge.add → task.take → task.resolve → note.add` y
    un subcomando que captura un fallo parcial).
  - `test/plugin-core-e2e.test.mjs` (nuevo; smoke V2: instala fixture,
    ejecuta el subcomando "happy", verifica envelopes, `history`,
    `plugin_id` en logs; error smoke: `edge.add` con id inexistente
    devuelve `PLUGIN_CORE_ACTION_FAILED` sin mutar; secuencia parcial:
    una `task.create` exitosa seguida de un `edge.add` con id
    inexistente deja el primer commit y reporta el error).
  - `test/plugin-core-concurrency.test.mjs` (nuevo; spawn de dos
    `child_process` con el mismo `CLIMIER_HOME` y mismo `--project`:
    uno ejecuta el fixture (subcomando que crea varias tasks), el otro
    corre `climier add-task`/`take` por CLI; verifica que el estado
    final es íntegro, que `plugin_id` aparece sólo en entradas del
    plugin, que no hay interleavings dentro de una misma entrada de
    log, y que la serialización bajo `withLock` evita lost-writes).
- **No-go zones**: `bin/`, `src/`, `test/*.test.mjs` existentes
  (sólo añadir los dos tests listados), `test/fixtures/sample-plugin/`,
  `docs/PLUGINS.md`, .adrs/, .decisions/.
- **Acceptance**: ver §7.

## 5. DAG y dependencias

```text
                            T-plugin-core-actions-v2-bootstrap
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
       T-plugin-core-foundation   T-plugin-core-log-seam
                  │                       │
                  └───────────┬───────────┘
                              ▼
                  T-plugin-core-api
                              │
                              ▼
                  T-plugin-core-parity
                              │
                              ▼
                  T-plugin-core-e2e
```

Tabla de dependencias:

| Task | Bloqueada por |
|---|---|
| `T-plugin-core-foundation` | `T-plugin-core-actions-v2-bootstrap` |
| `T-plugin-core-log-seam` | `T-plugin-core-actions-v2-bootstrap` |
| `T-plugin-core-api` | `T-plugin-core-actions-v2-bootstrap`, `T-plugin-core-foundation`, `T-plugin-core-log-seam` |
| `T-plugin-core-parity` | `T-plugin-core-actions-v2-bootstrap`, `T-plugin-core-api` |
| `T-plugin-core-e2e` | `T-plugin-core-actions-v2-bootstrap`, `T-plugin-core-parity` |

Todas las tasks hijas emiten `BLOCKS` con `from: <padre>, to: <hija>`
hacia la dependencia. La dirección canónica del ADR se respeta.

## 6. Batches paralelos

Después de que `T-plugin-core-actions-v2-bootstrap` quede resuelta:

- **Batch A (2 workers en paralelo)**:
  - `T-plugin-core-foundation` (extiende `src/plugin-errors.mjs`, crea
    `src/plugin-core-registry.mjs` con cinco entradas, escribe dos
    tests nuevos; no toca handlers, log ni api).
  - `T-plugin-core-log-seam` (extiende `src/log.mjs`, adapta cinco
    handlers con una línea cada uno, escribe un test nuevo; no toca
    errores, registry ni api).
  - **Sin conflicto**: paths disjuntos por construcción. `T-plugin-core-foundation`
    sólo lee `src/log.mjs` para confirmar que `append()` mantiene su
    firma; `T-plugin-core-log-seam` no abre `src/plugin-errors.mjs`.

- **Batch B (1 worker, requiere Batch A cerrado)**:
  - `T-plugin-core-api` (extiende `src/plugin-api.mjs`, crea
    `src/plugin-core-adapter.mjs`, extiende dos tests y crea uno).
  - El adapter importa registry (de foundation) y delega el log a
    `appendWithContext` (de log-seam); ambos ya están cerrados.

- **Batch C (1 worker, requiere Batch B cerrado)**:
  - `T-plugin-core-parity` (extiende registry con once entradas,
    adapta ocho handlers, extiende dos tests).

- **Batch D (1 worker, requiere Batch C cerrado)**:
  - `T-plugin-core-e2e` (crea fixture V2, dos tests de integración).

## 7. Comandos de verificación

Cada task debe pasar, en orden:

| Task | Comando |
|---|---|
| `T-plugin-core-foundation` | `node --test test/plugin-core-errors.test.mjs`, `node --test test/plugin-core-registry.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-core-log-seam` | `node --test test/plugin-log-seam.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-core-api` | `node --test test/plugin-api.test.mjs`, `node --test test/plugin-core-integration.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-core-parity` | `node --test test/plugin-core-registry.test.mjs`, `node --test test/plugin-api.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-core-e2e` | `node --test test/plugin-core-e2e.test.mjs`, `node --test test/plugin-core-concurrency.test.mjs`, `npm test`, `git diff --check` |

Verificación global del ADR:

```bash
node --test test/plugin-core-errors.test.mjs \
         test/plugin-core-registry.test.mjs \
         test/plugin-log-seam.test.mjs \
         test/plugin-api.test.mjs \
         test/plugin-core-integration.test.mjs \
         test/plugin-core-e2e.test.mjs \
         test/plugin-core-concurrency.test.mjs
npm test
```

Smoke manual del ADR (cubierto por `test/plugin-core-e2e.test.mjs`):

1. Instalar `test/fixtures/core-plugin/` desde path local.
2. El fixture ejecuta `task.create → edge.add → task.take → task.resolve → note.add`.
3. `history <id>` lista las entradas con `plugin_id` correcto y sin cuerpos privados.
4. Una operación desconocida (`core.run({ op: "edge.unknown" })`)
   devuelve `PLUGIN_CORE_INVALID_OPERATION` con `supported` y `op` en
   `details`, sin mutar.
5. Una `edge.add` con id inexistente devuelve
   `PLUGIN_CORE_ACTION_FAILED` con `cause.code = NODE_NOT_FOUND`.
6. Una `task.update` con `--if-revision` obsoleto devuelve
   `PLUGIN_CORE_ACTION_FAILED` con `cause.code = REVISION_CONFLICT`.
7. Una `task.create` que introduce un ciclo devuelve
   `PLUGIN_CORE_ACTION_FAILED` con `cause.code = CYCLE_DETECTED`.

Concurrencia (`test/plugin-core-concurrency.test.mjs`):

1. Spawn de proceso A (`core` fixture creando varias tasks).
2. Spawn simultáneo de proceso B (`climier add-task ... --as bob`).
3. Ambos comparten `CLIMIER_HOME` y `--project`.
4. Aserciones: estado final contiene ambos ids, log final contiene
   exactamente las entradas producidas, no hay interleavings dentro de
   una misma entrada, y `plugin_id` aparece sólo en las del proceso A.

## 8. Riesgos que invalidarían el orden

1. **Adapter sin registry.** Si `T-plugin-core-api` corre antes que
   `T-plugin-core-foundation`, importa un módulo que no existe. Mitigado:
   `T-plugin-core-api` depende explícitamente de la task de foundation.

2. **Adapter sin seam de log.** Si `T-plugin-core-api` corre antes que
   `T-plugin-core-log-seam`, los handlers aún llaman a `append()` y el
   log pierde `plugin_id`. Mitigado: el adapter no muta el log por sí
   mismo — la atribución vive en `appendWithContext`, que sólo existe
   tras la task de log-seam. La api-task verifica la atribución en el
   test de integración.

3. **Handlers adaptados sin registry.** Si `T-plugin-core-parity`
   corre antes que `T-plugin-core-api`, las nuevas entradas del
   registry no tienen consumer y los handlers adaptados quedan
   huérfanos. Mitigado: la api-task cierra el consumer antes de que
   parity añada entradas.

4. **Fixture V2 con dependencias runtime.** Si
   `test/fixtures/core-plugin/package.json` declara `dependencies`,
   `npm install --prefix` las descarga en CI y rompe el offline.
   Mitigado: el fixture es ESM puro sin `dependencies`,
   `devDependencies`, `peerDependencies`, ni
   `optionalDependencies` (verificación explícita en el test del
   descriptor del fixture, igual que `test/fixtures/sample-plugin/`).

5. **child_process con `CLIMIER_HOME` mal aislado.** Si
   `test/plugin-core-concurrency.test.mjs` corre sin sandbox, el
   `CLIMIER_HOME` real queda comprometido. Mitigido: el test usa el
   helper `withFreshEnv` (`test/helpers.mjs` +
   `test/plugin-integration.test.mjs` patrón ya establecido) que
   fuerza `CLIMIER_HOME` a un temp dir bajo `os.tmpdir()` y rechaza el
   home real con la guard rail de `helpers.mjs`. `smoke-sandbox.sh`
   no aplica aquí porque el test corre dentro de `node --test`.

6. **`isPluginCoreError` rompe `isPluginError`.** Si la nueva función
   filtra `PLUGIN_CORE_*` por algún criterio que no comparte con
   `isPluginError`, `dispatchPlugin` podría rewrappear. Mitigado:
   `isPluginCoreError` no se usa en `dispatchPlugin`; el adapter
   dentro de `core.run` hace el short-circuit con `isPluginError`
   (que ya acepta cualquier `PLUGIN_*`). El test
   `plugin-core-errors: PLUGIN_CORE_* does not get rewrapped by
   plugin-dispatch` lo verifica.

7. **Concurrencia no detecta interleavings.** El test podría pasar por
   timing aun cuando exista interleaving. Mitigado: el fixture del
   proceso A ejecuta varias acciones seguidas, y el test verifica
   que cada entrada de log tiene un único `ts` coherente (sin
   huecos), `agent` consistente y `action` único — cualquier
   interleaving detectado se manifestaría como entrada corrupta o
   faltante. El test corre con N=10 iteraciones por defecto.

8. **`task.update` con `--if-revision` rompe el contrato.** El ADR
   exige que `if_revision` obsoleto devuelva `PLUGIN_CORE_*` sin
   mutar. Si la registry traduce `if_revision` mal, el handler tira
   `REVISION_CONFLICT` directo y el adapter lo envuelve
   correctamente. Mitigado: el caso está cubierto en §7 smoke 6 y en
   el test table-driven de la registry.

9. **V1 rompe al añadir `core`.** Si `createApi` rompe la firma V1
   (`{ runtime, query, data }` cambia a `{ runtime, query, data, core }`),
   `test/plugin-api.test.mjs` y `test/plugin-integration.test.mjs`
   fallan. Mitigado: la firma V1 sigue presente (los cuatro campos
   coexisten); el test V1 verifica que `api.runtime`, `api.query` y
   `api.data` siguen exponiendo la misma superficie.

## 9. Decisiones explícitas

- **`api.core` siempre presente, no opcional.** ADR §"API y
  compatibilidad" dice que en un host V1 `api.core` está ausente, pero
  este milestone V2 ya landed en `main`; no mantenemos la rama
  condicional. El test verifica `api.core.version === 2` siempre.
  Una futura rama de coexistencia V1+V2 (back-port) puede
  reintroducir el condicional sin re-romper este contrato.

- **`input.as` se rechaza explícitamente.** Aunque el adapter fija
  `flags.as` desde `api.runtime.agent`, el input puede contener un
  `as` accidental. La registry lo rechaza con
  `PLUGIN_CORE_INVALID_OPERATION` y `reason: "input.as is forbidden"`.

- **`allow_unregistered_initiative` no se expone.** El escape del
  CLI no entra al input del plugin (ADR §"Registry y adaptación").

- **El helper `wrapCoreError` vive en `src/plugin-errors.mjs`.** No
  se reexporta desde `V2_ERROR_CODES` para mantener el catálogo
  `PLUGIN_*` aislado del core v2, igual que el patrón V1.

- **`updateState` queda sellado.** La task de log-seam sólo añade
  `appendWithContext`; la mutación del estado sigue siendo del
  handler. El atributo `plugin_id` se agrega al log, no al node,
  porque el ADR §"Secuencias parciales" dice que no se agregan
  campos de origen a los nodes.

- **La fixture V2 es independiente de la fixture V1.** Creamos
  `test/fixtures/core-plugin/` en lugar de extender
  `test/fixtures/sample-plugin/`. La fixture V1 prueba
  `runtime/query/data` y no debe crecer sin romper su contrato
  específico. La integración V1 (`test/plugin-integration.test.mjs`)
  sigue pasando sin cambios.

- **`history <id>` no necesita cambios.** ADR §"Secuencias parciales":
  "history <id> identifica plugin_id, agente y acción sin registrar
  cuerpos, metadata completa ni datos privados." El campo `plugin_id`
  ya se serializa cuando está presente; el resto del envelope es
  compatible.

- **`smoke-sandbox.sh` no se usa aquí.** El plan ejecuta mutaciones
  exclusivamente a través de `node --test`, que ya pasa por la guard
  rail de `helpers.mjs` (rechazo de `~/.climier`). El sandbox se
  reserva para smoke manual cuando se necesite ejecutar `climier
  status` sobre metadata copiada.

- **No hay bootstrap task que cree las hijas.** El ADR
  §"Checkpoint de planificación post-ADR" fija Bootstrap y este plan
  es su entregable; la creación de las cinco tasks queda al
  orchestrator tras validar este documento.

## 10. Lo que esta task no hace

- No implementa `api.core.run` (lo delegará a `T-plugin-core-api`).
- No implementa `appendWithContext` (lo delegará a
  `T-plugin-core-log-seam`).
- No modifica `bin/climier.mjs`, `src/state.mjs`, `src/lock.mjs`,
  `src/agent.mjs`, `src/errors.mjs`, `src/v2.mjs`,
  `src/v2-add-node.mjs` ni `src/v2.mjs`.
- No modifica `test/fixtures/sample-plugin/` ni
  `test/plugin-integration.test.mjs` (la fixture V1 sigue intacta).
- No modifica `docs/PLUGINS.md` (la guía de autoría se actualiza en
  una milestone posterior si hace falta; este plan sólo agrega
  `docs/plans/plugin-core-actions-v2-execution.md`).
- No crea plugins de producto.
- No resuelve gates ni delega workers.
- No commitea nada fuera de `docs/plans/plugin-core-actions-v2-execution.md`.

El cierre de `T-plugin-core-actions-v2-bootstrap` deja: este plan
commiteado, cinco tasks propuestas para que el orchestrator las cree
en Climier tras validar el documento, y una nota de cierre con los
ids y el orden propuesto.
