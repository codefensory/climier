# Plan de ejecución: host de plugins V1

Plan derivado de la inspección real del repo contra `.adrs/005-plugin-host-v1.md`.
Convierte el contrato del ADR en el DAG más pequeño que permita paralelismo real
sin solapamiento, fijando paths exclusivos, contratos compartidos, dependencias,
batches paralelos, comandos de verificación y riesgos que invalidarían el orden.

## 1. Punto de partida observado

Inspección del repo en `main` (HEAD `15cdd8c docs: approve plugin host v1 ADR`).

- `bin/climier.mjs` (200 líneas) resuelve argv, hace dispatch dinámico a
  `src/commands/<command>.mjs` y emite `{ok:false, error}` en stderr/stdout.
  No hay rama de namespaces instalados.
- `src/storage/state.mjs` define `version: 2` con `nodes/edges/initiatives/log`.
  `emptyState()`, `writeState`, `updateState`, `createSnapshot`,
  `listSnapshots` y `restore` preservan cualquier clave top-level/por-nodo
  porque serializan con `JSON.stringify` y los mutadores usan spreads
  (`{ ...state }`, `{ ...state.nodes }`). Ningún mutador hace reset
  destructivo del estado fuera de `init --force`.
- `src/lock.mjs` expone `withLock(projectDir)` con file lock bajo
  `<state-dir>/.lock` (default 10s, `fs.openSync('wx')` + spinlock).
  No hay un lock de scope global; cualquier nuevo lock debe vivir en su
  propio archivo y no contaminar este.
- `src/storage/paths.mjs` resuelve `<CLIMIER_HOME>/projects/<id>/tasks.json` y
  `<project>/.climier.json`. No existe aún `<CLIMIER_HOME>/plugins/`.
- `src/agent.mjs` resuelve identidad con precedencia `--as` > `CLIMIER_AGENT`
  > `MISSING_AGENT`. Lo reutilizaremos para el runtime del plugin.
- `src/commands/` tiene 25 comandos; los mutadores relevantes para
  preservación de plugins son `init`, `add-node` (usado por los wrappers
  `add-task`/`add-gate`/`add-knowledge`), `update`, `take`, `resolve`,
  `reopen`, `release`, `cancel`, `snapshots` (read-only) y `restore`.
- `src/errors.mjs` define `V2_ERROR_CODES` y `throwV2`. El ADR exige
  códigos `PLUGIN_*` no presentes aún; el bootstrap debe extender el
  catálogo o emitir errores estructurados con códigos literales sin
  pasar por `throwV2` (ver §3).
- `src/v2.mjs` deriva `ready/blocked/backlog/openGates` y `isSatisfiedV2`
  ignorando campos desconocidos en el nodo. Los campos `plugins` raíz y
  `nodes[id].plugins` son aditivos y no afectan la derivación.
- `src/v2-add-node.mjs` es el wrapper que `add-task`/`add-gate`/
  `add-knowledge` invocan; no toca plugins ni el descriptor.
- `test/` corre `npm test` con 720 pass / 0 fail / 1 skipped (~14s).
  `test/helpers.mjs` exige `CLIMIER_HOME` bajo `os.tmpdir()`; nunca se
  toca `~/.climier`. `smoke-sandbox.sh` está disponible para mutaciones
  de smoke.

## 2. Mapa de módulos/entrypoints y locks

Texto = estado actual; sufijo `(V1)` = lo que añade el plan.

```text
bin/climier.mjs                      CLI entry; argv + dispatch
  └─── core <name>           → src/commands/<name>.mjs   (actual)
  └─── plugin <ns> <sub>     → src/plugin-dispatch.mjs    (V1)
  └─── reserved list         → src/commands/reserved-namespaces.mjs (V1)

src/commands/                        25 comandos core (actual)
  + install.mjs                     PLUGIN lifecycle (V1)
  + uninstall.mjs                   PLUGIN lifecycle (V1)
  + reserved-namespaces.mjs         core namespace list + uniqueness (V1)

src/plugin-dispatch.mjs              decide core/installed/unknown (V1)
src/plugin-loader.mjs                lazy import + shape validation (V1)
src/plugin-paths.mjs                 CLIMIER_HOME/plugins/* layout (V1)
src/plugin-lock.mjs                  withGlobalPluginLock (V1)
src/plugin-api.mjs                   createApi({ projectDir, agent, pluginId }) (V1)
src/plugin-runtime.mjs               resolveRuntime(argv) (V1)
src/plugin-query.mjs                 api.query.* (V1)
src/plugin-data.mjs                  api.data.* con withLock + log redactado (V1)

src/storage/state.mjs                        version: 2; plugins preservado (cambios mínimos)
src/lock.mjs                         withLock(projectDir) — sin cambios
src/agent.mjs                        resolveAgent — sin cambios
src/errors.mjs                       V2_ERROR_CODES — sin cambios (PLUGIN_* se emite literal)
```

Locks:

| Lock | Path | Scope | Uso |
|---|---|---|---|
| `withLock(projectDir)` | `<state-dir>/.lock` | proyecto | mutadores de estado y `data.*.set` |
| `withGlobalPluginLock` | `<CLIMIER_HOME>/plugins/.lock` | global | `install`/`uninstall` para serializar staging |

Los dos locks son disjuntos y no deben anidarse en una misma unidad de
trabajo. `install`/`uninstall` toman el lock global, ejecutan npm, y
salen sin tocar `<state-dir>/.lock`. `data.*.set` toma el lock del
proyecto, nunca el global.

## 3. Contratos compartidos que deben preceder consumidores

### 3.1 Descriptor del paquete

Definido por el ADR §"Instalación e identidad":

```json
{
  "climier": { "id": "example.audit", "command": "audit", "entry": "./climier.mjs" }
}
```

Validación: regex `^[A-Za-z0-9][A-Za-z0-9._-]*$` para `id`, unicidad
de `id` y `command` contra `installed/*` y contra la lista de
namespaces reservados. `entry` debe resolver a un módulo ESM con
`default.commands` objeto.

Este contrato es consumido por dos productores (`install`, `uninstall`)
y un consumidor (`plugin-loader`). Como `install`/`uninstall` y
`plugin-loader` viven en tasks distintas, el contrato se materializa
como módulo compartido: `src/plugin-descriptor.mjs`. Lo crea
`T-plugin-install` y lo consume `T-plugin-dispatch`.

### 3.2 Namespaces reservados

Lista única exportada en `src/commands/reserved-namespaces.mjs`:

```text
status, context, take, resolve, release, cancel, reopen, search,
history, show, update, add-note, add-initiative, add-task, add-gate,
add-knowledge, deprecate-knowledge, add-node, add-edge, initiatives,
log, init, snapshots, restore, ui, help, version, install, uninstall
```

Este módulo se crea en `T-plugin-install` (porque `install` debe
rechazar colisiones) y se consume en `T-plugin-dispatch` (porque el
dispatcher debe distinguir core de plugin). El test de unicidad vive
en `test/plugin-install.test.mjs` y `test/plugin-dispatch.test.mjs`
deben importarlo sin redefinirlo.

### 3.3 Envolvente de error de plugin

El ADR exige un único envelope JSON para todos los errores de plugin
con `code ∈ { PLUGIN_INVALID_DESCRIPTOR, PLUGIN_LOAD_FAILED,
PLUGIN_ID_CONFLICT, PLUGIN_SUBCOMMAND_NOT_FOUND, PLUGIN_HANDLER_FAILED
}`. `src/errors.mjs` no tiene estos códigos en `V2_ERROR_CODES` y el
bin los emite sólo si `err.code` y `err.details` están presentes. La
implementación emite errores con `err.code` y `err.details` desde un
helper compartido `src/plugin-errors.mjs` (creado por
`T-plugin-dispatch`); `bin/climier.mjs` ya los serializa con
`failJson({ code, message, details }, 1)` sin necesidad de cambios.

### 3.4 Preservación de `plugins`

Raíz: `plugins[pluginId].data`. Por nodo: `nodes[id].plugins[pluginId].data`.
`meta` (de un nodo) y `nodes[id].plugins` son keyspaces disjuntos;
mutaciones concurrentes deben preservar ambos. `data.*.set` exige
identidad y agrega log con `action: "plugin-data-set"`, `plugin_id`,
`scope: "node"|"project"`, `node_id?`, sin el valor.

Este contrato lo materializa `T-plugin-state` (verificando que ya se
preserva) y lo consume `T-plugin-api` (que es quien escribe). Como
`T-plugin-state` corre antes que `T-plugin-api`, no hay riesgo de
contrato implícito.

## 4. Cortes de tasks con paths exclusivos

Cinco tasks, cada una con un único cambio principal, paths
verificables, no-go zones explícitas y comandos de aceptación.

### 4.1 `T-plugin-state` — Compatibilidad de estado v2 y preservación

- **Cambio principal**: verificación y, si hace falta, ajustes no
  rompedores para que `plugins` y `nodes[id].plugins` sobrevivan a
  todos los mutadores y a `snapshots`/`restore`.
- **Paths propios**:
  - `src/storage/state.mjs` (comentarios de contrato; ningún cambio de schema).
  - `src/commands/init.mjs`, `add-node.mjs`, `update.mjs`, `take.mjs`,
    `resolve.mjs`, `reopen.mjs`, `release.mjs`, `cancel.mjs`,
    `snapshots.mjs`, `restore.mjs` (verificación; ajustar si hace
    falta para preservar campos).
  - `test/plugin-compat.test.mjs` (nuevo).
- **No-go zones**: `bin/climier.mjs`, `src/plugin-*`, fixtures,
  docs/, .adrs/, .decisions/.
- **Acceptance**: ver §7.

### 4.2 `T-plugin-install` — Comandos install/uninstall con staging aislado

- **Cambio principal**: comandos core `install`/`uninstall` con
  staging bajo `CLIMIER_HOME/plugins/.staging/<nonce>` y promoción
  por rename a `installed/<climier.id>`. Lock global.
- **Paths propios**:
  - `src/commands/install.mjs` (nuevo).
  - `src/commands/uninstall.mjs` (nuevo).
  - `src/plugin-paths.mjs` (nuevo).
  - `src/plugin-lock.mjs` (nuevo; `withGlobalPluginLock`).
  - `src/plugin-descriptor.mjs` (nuevo; contrato §3.1).
  - `src/commands/reserved-namespaces.mjs` (nuevo; §3.2).
  - `test/plugin-install.test.mjs` (nuevo).
- **No-go zones**: `bin/climier.mjs`, `src/plugin-dispatch.mjs`,
  `src/plugin-loader.mjs`, `src/plugin-api.mjs`, mutadores de estado,
  fixtures, docs/.
- **Acceptance**: ver §7.

### 4.3 `T-plugin-dispatch` — Discovery, namespaces reservados y dispatch

- **Cambio principal**: refactor de `bin/climier.mjs` para resolver
  el primer token; loader lazy; errores `PLUGIN_*`; preservación del
  orden de tokens; `api.runtime` consumido desde `T-plugin-api` (seam).
- **Paths propios**:
  - `bin/climier.mjs` (refactor de dispatch).
  - `src/plugin-dispatch.mjs` (nuevo; decide core/installed/unknown).
  - `src/plugin-loader.mjs` (nuevo; import lazy + shape validation).
  - `src/plugin-errors.mjs` (nuevo; helper para envelope §3.3).
  - `test/plugin-dispatch.test.mjs` (nuevo).
- **No-go zones**: `src/commands/install.mjs`, `src/commands/uninstall.mjs`,
  `src/plugin-api.mjs` (sólo invoca `createApi` vía seam), mutadores
  de estado, fixtures, docs/.
- **Acceptance**: ver §7.

### 4.4 `T-plugin-api` — Superficie runtime/query/data del host

- **Cambio principal**: superficie V1 del host
  (`runtime`/`query.*`/`data.*.get/set`) con lock por proyecto y
  log redactado.
- **Paths propios**:
  - `src/plugin-api.mjs` (nuevo; `createApi`).
  - `src/plugin-runtime.mjs` (nuevo).
  - `src/plugin-query.mjs` (nuevo).
  - `src/plugin-data.mjs` (nuevo; `withLock` + log).
  - `test/plugin-api.test.mjs` (nuevo).
- **No-go zones**: `bin/climier.mjs`, `src/plugin-dispatch.mjs`,
  `src/plugin-loader.mjs`, `src/commands/install.mjs`,
  `src/commands/uninstall.mjs`, fixtures, docs/.
- **Acceptance**: ver §7.

### 4.5 `T-plugin-fixture` — Fixture V1 y verificación end-to-end

- **Cambio principal**: paquete fixture mínimo bajo
  `test/fixtures/sample-plugin/` que cubre cada método V1; test e2e
  que ejecuta el smoke del ADR; guía de autoría.
- **Paths propios**:
  - `test/fixtures/sample-plugin/package.json` (nuevo).
  - `test/fixtures/sample-plugin/climier.mjs` (nuevo; entrypoint).
  - `test/plugin-integration.test.mjs` (nuevo).
  - `docs/PLUGINS.md` (nuevo; guía de autoría).
- **No-go zones**: `bin/`, `src/`, `test/*.test.mjs` existentes
  (sólo añadir `plugin-integration.test.mjs`), .adrs/, .decisions/.
- **Acceptance**: ver §7.

## 5. DAG y dependencias

```text
                            T-plugin-v1-bootstrap
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     │
  T-plugin-state        T-plugin-install            │
        │                     │                     │
        │                     └────┐                │
        │                          ▼                 │
        │                  T-plugin-dispatch        │
        ▼                          │                │
  T-plugin-api ────────────────────┤                │
                                   ▼                │
                          T-plugin-fixture ◀────────┘
```

Tabla de dependencias:

| Task | Bloqueada por |
|---|---|
| `T-plugin-state` | `T-plugin-v1-bootstrap` |
| `T-plugin-install` | `T-plugin-v1-bootstrap` |
| `T-plugin-dispatch` | `T-plugin-v1-bootstrap`, `T-plugin-install` |
| `T-plugin-api` | `T-plugin-v1-bootstrap`, `T-plugin-state` |
| `T-plugin-fixture` | `T-plugin-v1-bootstrap`, `T-plugin-dispatch`, `T-plugin-api` |

Todas las tasks hijas emiten `BLOCKS` con `from: <padre>, to: <hija>`
hacia la dependencia. La dirección canónica del ADR se respeta:
el blocker es el origen, el bloqueado es el destino.

## 6. Batches paralelos

Después de que `T-plugin-v1-bootstrap` quede resuelta:

- **Batch A (2 workers en paralelo)**:
  - `T-plugin-state` (sin overlap con nadie; sólo verifica y, si hace
    falta, ajusta mutadores; escribe `test/plugin-compat.test.mjs`).
  - `T-plugin-install` (crea archivos nuevos en `src/plugin-*`,
    `src/commands/{install,uninstall,reserved-namespaces}.mjs`,
    escribe `test/plugin-install.test.mjs`; no toca state ni bin).
  - **Sin conflicto**: paths disjuntos por construcción. `T-plugin-state`
    sólo lee `src/plugin-*` para confirmar que aún no existen y que
    la API surface futura no está duplicada; `T-plugin-install` no
    abre `src/storage/state.mjs`.

- **Batch B (2 workers en paralelo, requiere Batch A cerrado)**:
  - `T-plugin-dispatch` (toca `bin/climier.mjs`, `src/plugin-dispatch.mjs`,
    `src/plugin-loader.mjs`, `src/plugin-errors.mjs`).
  - `T-plugin-api` (toca `src/plugin-api.mjs`, `src/plugin-runtime.mjs`,
    `src/plugin-query.mjs`, `src/plugin-data.mjs`).
  - **Sin conflicto**: las dos workers sólo tocan archivos nuevos y
    bin. `T-plugin-dispatch` importa `createApi` desde
    `src/plugin-api.mjs` mediante seam documentado; `T-plugin-api`
    expone `createApi` con una firma estable. Si la firma cambia
    durante el trabajo, los dos reabren; pero como el seam está
    explícito, la probabilidad de colisión es baja.

- **Batch C (1 worker, requiere Batch B cerrado)**:
  - `T-plugin-fixture` (crea paquete fixture, test e2e, docs/PLUGINS.md).

## 7. Comandos de verificación

Cada task debe pasar, en orden:

| Task | Comando |
|---|---|
| `T-plugin-state` | `node --test test/plugin-compat.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-install` | `node --test test/plugin-install.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-dispatch` | `node --test test/plugin-dispatch.test.mjs`, `node --test test/cli-dispatch.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-api` | `node --test test/plugin-api.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-fixture` | `node --test test/plugin-integration.test.mjs`, `npm test`, `git diff --check` |

Verificación global del ADR:

```bash
node --test test/plugin-compat.test.mjs \
         test/plugin-install.test.mjs \
         test/plugin-dispatch.test.mjs \
         test/plugin-api.test.mjs
npm test
```

Smoke manual del ADR (cubierto por `test/plugin-integration.test.mjs`):

1. Instalar un fixture local (`test/fixtures/sample-plugin/`).
2. Ejecutar sus subcomandos con flags reenviados
   (`--project`, `--as`, `--force`).
3. Comprobar `plugins[<id>].data` raíz y
   `nodes[<id>].plugins[<id>].data` por nodo.
4. Verificar que el log lleva `action: plugin-data-set` y no el valor.
5. Desinstalar (`climier uninstall <id>`).
6. Reinstalar; los datos persisten.

## 8. Riesgos que invalidarían el orden

1. **Discovery antes de install.** Si `T-plugin-dispatch` corre sin
   que `installed/` exista, no hay nada que descubrir; las pruebas de
   dispatch fallarían por no encontrar fixtures. Mitigado: el orden
   Batch A → Batch B garantiza `T-plugin-install` antes de
   `T-plugin-dispatch`.

2. **`data.*.set` antes de preservación.** Si `T-plugin-api` corre
   sin `T-plugin-state`, los datos del plugin podrían perderse en un
   `take` o `resolve` posterior. Mitigado: `T-plugin-api` depende de
   `T-plugin-state`.

3. **Cambio del seam `createApi`.** Si `T-plugin-api` modifica la
   firma entre el commit de `T-plugin-dispatch` y su merge, el
   dispatch falla en runtime. Mitigado: el seam es una sola función
   con firma `{ projectDir, agent, pluginId } → { runtime, query, data }`;
   cualquier cambio debe reabrir el dispatch.

4. **Lock global no serializa correctamente.** Si `withGlobalPluginLock`
   no es realmente exclusivo (por ejemplo, mismo path pero `wx`
   fallando por ENOENT antes de crear el dir padre), dos installs
   concurrentes pueden corromper `installed/`. Mitigado: el módulo
   `src/plugin-lock.mjs` reutiliza el patrón de `src/lock.mjs`
   (`ensureTasksDir` antes del spinlock) y se prueba con dos
   installs paralelos.

5. **Descriptor válido pero código de plugin hace side effects en
   `import`.** El ADR dice que el host "no ejecuta rollback npm ni
   promete revertir side effects de código importado". Esto NO es
   un riesgo de orden, sino un recorte explícito; no requiere task
   adicional.

6. **Fixture usa `npm install` contra un paquete local con deps
   externas.** Si `test/fixtures/sample-plugin/package.json` declara
   dependencias, `npm install --prefix` las descarga. Mitigado: el
   fixture no debe tener dependencias runtime; sólo `type: "module"`
   y un entrypoint autocontenido. Las pruebas lo verifican.

7. **Versión de Node cambia entre runs.** El repo fija `node --test`
   (sin `vitest`/transpiladores); el fixture debe ser ESM puro. Si
   alguien añade tooling, las dos tasks de fixture y de install
   fallan en local. Mitigado: nada en el plan introduce tooling.

## 9. Decisiones explícitas

- **No se introduce un registry central ni un `manifest.json`**. El
  ADR §"Instalación e identidad" fija que cada `installed/<id>/`
  contiene su propio `package.json` y `node_modules`. La lista de
  plugins se deriva de leer los directorios; no hay un archivo de
  índice.
- **El loader no cachea entre invocaciones**. Cada `node bin/climier.mjs`
  es un proceso nuevo, así que V1 no necesita invalidación ni
  cache compartida. Esta decisión vive en el ADR y no requiere task.
- **Los códigos `PLUGIN_*` no entran en `V2_ERROR_CODES`**. Se emiten
  con `err.code`/`err.details` literales desde `src/plugin-errors.mjs`.
  Esto evita ensuciar `src/errors.mjs` con códigos que sólo el host
  conoce y mantiene el bin como ya está.
- **`uninstall` no purga datos**. Documentado en el ADR §"Plan de
  implementación" 2; sin task adicional.
- **`meta.execution.checks` por task**. Cada task de implementación
  declara sus checks (`node --test test/plugin-X.test.mjs`, `npm
  test`, `git diff --check`) en `meta.execution.checks` para que
  `finish-task.sh` los corra automáticamente.

## 10. Lo que esta task no hace

- No implementa el host (lo delegará a las cinco tasks creadas).
- No modifica `bin/`, `src/`, `test/`, `ui/`, .adrs/ ni .decisions/.
- No crea plugins de producto.
- No resuelve gates ni delega workers.
- No commitea nada fuera de `docs/plans/plugin-host-v1-execution.md`.

El cierre de `T-plugin-v1-bootstrap` deja: este plan commiteado,
cinco tasks en el DAG de climier bloqueadas por esta misma task, y
una nota de cierre con los ids y el orden.
