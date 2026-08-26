# ADR-005: host de plugins V1

- Gate: `G-plugin-host-v1-adr` · Deriva de: `G-plugin-platform-rfc` · Estado: aprobado
- Fecha: 2026-08-26

## Contexto

Climier necesita permitir extensiones instalables sin que cada integración modifique el core, pero el host no puede relajar las garantías de estado v2: DAG, lifecycle, locks, escrituras atómicas y log siguen siendo responsabilidad exclusiva del core.

El RFC `G-plugin-platform-rfc` comparó alternativas y fue aprobado. Esta ADR fija el contrato implementable de V1; el RFC conserva el detalle de investigación, alternativas y trazabilidad de revisiones.

## Decision

### Instalación e identidad

Un paquete declara en su `package.json`:

```json
{
  "climier": {
    "id": "example.audit",
    "command": "audit",
    "entry": "./climier.mjs"
  }
}
```

- `climier.id` coincide con `^[A-Za-z0-9][A-Za-z0-9._-]*$`, es único y es la identidad persistida, key de datos y argumento de `climier uninstall`.
- `command` es un namespace CLI único y no puede colisionar con uno reservado por el core.
- El nombre npm solo es el origen de instalación; no identifica datos ni determina `uninstall`.
- Bajo un lock global de `CLIMIER_HOME/plugins`, `install` ejecuta npm en un prefijo temporal `.staging/<nonce>`, valida descriptor, import ESM y `default.commands`, y promociona el staging mediante rename a `installed/<climier.id>`.
- Cada directorio instalado contiene su prefijo npm, `package.json` y `node_modules`; no existe un registry central o manifest adicional. `uninstall <id>` elimina ese directorio y no purga datos de proyectos.
- Un error de npm, descriptor, import o shape elimina el staging con `fs.rm` y devuelve un error estructurado. El host no ejecuta rollback npm ni promete revertir side effects de código importado.

### Dispatch y contrato de errores

`bin/climier.mjs` resuelve un namespace instalado antes de su fallback de comando core. La invocación es:

```text
climier <namespace> <subcommand> [tokens]
```

El handler se toma de `default.commands[subcommand]`. Namespace desconocido conserva exit `2`; namespace instalado sin subcommand o con subcommand inexistente devuelve `PLUGIN_SUBCOMMAND_NOT_FOUND` y exit `1`.

El host resuelve `--project` y `--as` para sí mismo, pero reenvía al handler todos los tokens originales salvo namespace y subcommand, en su orden original, incluidos esos flags y booleanos propios. Los valores efectivos de proyecto e identidad viven en `api.runtime`; los tokens reenviados no pueden alterarlos. `CLIMIER_AGENT` es fallback de identidad cuando no existe `--as`.

Errores de descriptor, instalación, carga, datos y handler usan el envelope JSON existente:

```json
{
  "ok": false,
  "error": { "code": "PLUGIN_HANDLER_FAILED", "message": "...", "details": {} }
}
```

con exit `1`. El host captura errores de import y de la promesa del handler; trabajo en background y errores posteriores al retorno quedan fuera del contrato V1.

### API y persistencia

La superficie V1 es:

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

`query.*` es lectura sin lock del último estado serializado observable. `query.context` usa la identidad runtime. `query.node` devuelve el node raw; `data.node.get` solo devuelve los datos del plugin llamante.

Los datos son JSON serializable sin límite de tamaño en V1 y permanecen en campos opcionales compatibles con schema v2:

- node: `nodes[id].plugins[climier.id].data`;
- proyecto: `plugins[climier.id].data`.

Cada `data.*.set` exige identidad, toma el lock de proyecto, relee estado, modifica solo su keyspace, escribe atómicamente y agrega un log sin el valor completo. `meta` y `nodes[id].plugins` son keyspaces disjuntos; las mutaciones concurrentes deben preservar ambos. No hay `data.update`, `api.core.run`, hooks, eventos, workers, UI, permisos, límites, secretos ni cambios de DAG/lifecycle en V1.

`plugins` es aditivo y opcional: se mantiene `version: 2`; los mutadores core, snapshots y restore preservan estos campos, y el DAG no deriva semántica de ellos.

## Consecuencias

- A favor: extensiones instalables con comandos y datos propios sin escritura directa de `tasks.json`, sin dependencias runtime nuevas y sin cambiar el esquema/lifecycle core.
- A favor: identidad independiente de npm, instalación aislada por plugin y pruebas concretas de lock y preservación.
- En contra / deuda: el código del plugin corre con permisos del usuario; no hay sandboxing, pinning, firma, timeout ni protección contra side effects asíncronos.
- En contra / deuda: los datos grandes reescriben `tasks.json`; V1 deja ese coste bajo control del usuario.
- Follow-up explícito: una necesidad real de automatización u operaciones core promueve `T-plugin-v2-rfc-backlog`; la UI de plugins permanece en `G-plugin-ui-rfc`.

## Plan de implementación

1. Compatibilidad de estado v2 y preservación — `src/state.mjs`, mutadores afectados, snapshots/restore y pruebas de regresión para root/node `plugins`.
2. Instalación aislada — utilidades de paths/lock global y comandos `install`/`uninstall`; staging, validación, promoción, cleanup y pruebas concurrentes con npm controlado.
3. Discovery, namespaces y dispatch — loader lazy, lista única de namespaces reservados y cambios en `bin/climier.mjs`; pruebas de colisión, flags y envelopes.
4. API host — adaptadores read-only para `query.*`, `runtime` y transacciones `data.*` bajo lock con log redactado; pruebas de aislamiento y de `meta`/plugin data concurrentes.
5. Fixture e integración — fixture técnico que cubra cada método V1, pruebas CLI end-to-end, compatibilidad, uninstall/reinstall y documentación de autoría/instalación.

Las tasks se crean solo después de resolver `G-plugin-host-v1-adr` y se ordenan según estas dependencias; ningún worker implementa dos piezas que compitan por `bin/climier.mjs` o el mismo módulo de estado.

## Verificación

- `node --test test/plugin-compat.test.mjs`
- `node --test test/plugin-install.test.mjs`
- `node --test test/plugin-dispatch.test.mjs`
- `node --test test/plugin-api.test.mjs`
- `npm test`
- Smoke: instalar un fixture local, ejecutar sus subcommands con flags reenviados, comprobar datos root/node y log redactado, desinstalar, reinstalar y verificar que los datos persisten.
