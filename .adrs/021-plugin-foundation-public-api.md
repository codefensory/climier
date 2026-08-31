# ADR-021: Superficie pública coherente para CLI y plugins

- Gate: `G-plugin-foundation-api-adr` · Deriva de: `G-plugin-foundation-rfc` · Estado: borrador
- Fecha: 2026-08-31

## Contexto

Un plugin puede consultar nodos, status e history, pero debe componer lecturas
que pueden pertenecer a revisiones distintas. `api.data` usa structured clone,
no define delete, y no ofrece un lugar para runtime pesado. La API no declara
compatibilidad en el descriptor y la CLI JSON-only aún tiene rutas de error y
salida heterogéneas.

La nueva superficie debe bastar para que un proceso externo observe una versión
coherente y aplique un batch CAS sin importar `src/kernel`, `src/storage` o
adapters internos.

## Decision

1. `api.query.snapshot()` lee una sola vez y devuelve una proyección JSON
   determinista `{ revision, nodes, edges, derived, plugins }`. `derived` se
   limita a lifecycle del core (`open`, `ready`, `blocked`, `in_progress`,
   `submitted`, `done`, terminales existentes) y no incluye planner,
   ownership ni semántica de execution. El plugin recibe únicamente
   `plugins[pluginId]`; nunca los namespaces de otros plugins.
2. El CLI expone la misma lectura mediante `climier state`. No se añade
   `--json`: toda la CLI es JSON-only. Nodes, arrays de edges y proyecciones
   usan orden estable por id/triple; el mismo estado produce el mismo output.
3. La CLI normaliza rutas públicas relevantes (task create/update, edge
   add/remove, batch, state, context, status, gate y knowledge) a respuestas
   JSON máquina-legibles y errores `{ ok:false, error:{ code,message,details } }`.
   Los códigos son API; la política de exit codes se documenta y prueba por
   clases de éxito, uso/comando, conflicto de dominio y fallo storage/interno.
   No se exige migrar de golpe cada envelope histórico que no necesite un
   replanner; las operaciones nuevas exponen revisión/operación de manera
   explícita.
4. Plugin data acepta sólo valores JSON: `null`, boolean, string, número
   finito, array y plain object acíclico. Rechaza `undefined`, `NaN`, infinito,
   BigInt, Map, Set, funciones, symbols, instancias y ciclos con código
   estable, antes de mutar. Se agregan `data.node.delete(id)` y
   `data.project.delete(key)`, idempotentes y namespaced. `api.data` es
   metadata estructurada pequeña, no artifact store.
5. `api.runtime.dataDir` se resuelve como
   `~/.climier/projects/<project-id>/plugins/<plugin-id>/`, se crea antes de
   devolver la API, valida el id y nunca interpreta su contenido. El plugin es
   dueño de SQLite, artifacts, logs, sessions y cache allí; no hay migración ni
   sincronización del host.
6. La Plugin API se fija en versión 3. `api.version === 3` y el descriptor
   exige `climier.api: 3`. Descriptor ausente, malformado o una versión no
   ofrecida falla `PLUGIN_API_INCOMPATIBLE` antes de importar entrypoint.
   La superficie pública estable es sólo `api.query.*`, `api.core.*`,
   `api.data.*` y `api.runtime.*`; `src/**` es internal. `api.core` incluye
   las operaciones registradas después de ADR-018/019 y `batch` después de
   ADR-020; actor/pluginId siguen fijados por el host.

## Consecuencias

- A favor: plugins y shell automatizados tienen una lectura/revisión común y
  una ruta de escritura pública, sin parsing de prose ni imports internos.
- A favor: datos ligeros no contaminan el estado con tipos no serializables y
  artifacts grandes no penalizan cada commit del grafo.
- En contra: API v3 rompe fixtures/descriptores v2 y requiere una migración de
  documentación de plugin authors.
- En contra: crear dataDir es I/O durante creación de API; debe fallar de forma
  clara si el filesystem no es escribible.

## Plan de implementacion

1. Implementar proyección snapshot determinista y comando `state` sobre una
   lectura única; limitar y filtrar plugin data — archivos: read-model,
   `src/plugins/query.mjs`, nuevo command y tests.
2. Endurecer JSON data y delete bajo el kernel, y añadir `runtime.dataDir` con
   path safety — archivos: plugin-data providers, transaction, plugins data/
   runtime/paths/API y tests de aislamiento/persistencia.
3. Versionar descriptor/API, fijar compatibilidad antes de import, actualizar
   fixtures y documentación pública — archivos: descriptor/loader/API,
   fixtures, `docs/PLUGINS.md`, AGENTS/reference.
4. Normalizar la superficie y clasificación CLI necesaria para el flujo de
   agents, después de state/batch; crear la suite fake-plugin que usa sólo
   `api.*` y los comandos públicos.

## Onboarding breve para crear tasks

- [x] Realizado — snapshot/state comparte read-model/plugin query; data JSON y
  runtime comparten API pero no los mismos módulos; versionado requiere que la
  superficie final (batch y resolve removal) ya esté definida. La normalización
  CLI y acceptance fake-plugin se dejan al final como integración.

## Verificacion

- Un plugin obtiene snapshot coherente con su namespace solamente, calcula
  fuera del core y aplica batch CAS sin importar módulos internos.
- Plugin A no puede leer/escribir/borrar datos de Plugin B; valores no JSON no
  mutan ni loguean; deletes y runtime data sobreviven restart.
- Un descriptor que requiere API 4 falla `PLUGIN_API_INCOMPATIBLE` antes de
  ejecutar su módulo.
- Desde shell, `state`, `batch` y `state` reparan un DAG; todas las salidas
  requeridas son JSON estructurado y determinista.
- `npm test`, `npm run test:concurrent` y las pruebas UI aplicables quedan
  verdes.
