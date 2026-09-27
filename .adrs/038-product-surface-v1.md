# ADR-038: superficie de producto en 1

- Gate: `G-v1-baseline-adr-038` · Deriva de: `G-v1-baseline-rfc` · Estado: borrador
- Fecha: 2026-09-27

## Contexto

La superficie pública arrastra acomodos que existen solo por historia: filtros aceptados e ignorados (`take --initiative/--domain/--tag`, `install --as`), correcciones que el CLI hace en silencio para parecerse a una versión anterior (`resolve` inyecta `resolution_mode` y resetea `resolved`), un parche sin tipar para no perder campos históricos (`update`), un camino sin control de revisión para fixtures viejas (`add-note`), y filtros de log que siguen buscando `task`/`decision`/`gotcha` para que entradas antiguas sigan apareciendo. Además los números de versión de otras capas quedaron dispares: la API de plugins en `3` (`PLUGIN_API_VERSION` en `src/plugins/descriptor.mjs:22`), la versión del core API expuesta al host en `2`, y el payload de transferencia en `4` (`src/storage/transfer.mjs:42`, validado por `src/server/http/transfers.mjs:12-15`). El RFC aprobado decidió que todo quede en 1 y que nada se publique nunca (verificado: `npm view climier version` responde 404), así que no hay consumidor externo que romper.

## Decisión

1. **`take` deja de aceptar filtros que ignora.** `--initiative`, `--domain` y `--tag` salen de `knownFlags` (`src/cli/commands/take.mjs:13`) y pasan a ser unknown flags. `take` recibe un id explícito y nada más.
2. **`install` y `uninstall` dejan de aceptar `--as`.** Ninguna operación de plugin lleva actor.
3. **`resolve` deja de corregir la historia, y el contrato queda explícito.** No inyecta `resolution_mode: "choice"` ni convierte `resolved` en `open`. Un segundo `resolve` sobre un gate ya resuelto **falla** con `INVALID_STATUS`, incluso si la elección y la racionalidad son idénticas; corregir una decisión requiere `reopen`. Hoy el adaptador local trata el gate como `open` en la preparación y puede sobrescribir choice o rationale, mientras que el provider estricto y el camino remoto rechazan el estado terminal: sin fijar el contrato, un retry puede cambiar la decisión o comportarse distinto según backend (`src/cli/commands/resolve.mjs:16-36`, `src/providers/gate/lifecycle.mjs`).
4. **`update` pierde el parche sin tipar, y el contrato por kind queda completo.** Solo se aplican las claves declaradas por el provider; un campo desconocido es un error, no un `legacy_patch` (`src/cli/commands/update.mjs:168-200`). **El criterio no es la documentación, es el modelo.** Hoy el adaptador reparte cada flag entre tipado y legacy con `PROVIDER_PATCH_KEYS` (`update.mjs:168-180`) y las tres allowlists no coinciden: `gate.update` declara `meta`, `backlog`, `purpose` y `resolution_mode` (`src/providers/gate/update.mjs:17-30`), `knowledge.update` tipa `meta` (`src/providers/knowledge/update.mjs:146`), y `task.update` declara diez claves y ninguna de esas (`src/providers/task/update.mjs:30-41`). Todo lo que cae en `legacy` se escribe en el nodo sin contrato: `--purpose`, `--resolution-mode`, `--mitigation`, `--knowledge-type` o `--scope-*` sobre una task, o `--backlog` sobre un knowledge. El trabajo de esta decisión es entonces un inventario clave por clave —21 flags conocidos por tres kinds— con un resultado binario y explícito: **o la clave entra a la allowlist del kind, o el kind la rechaza con un error que nombra las permitidas**. Nunca se escribe en silencio.
   Dos casos que el inventario ya resuelve contra el código: `backlog` es un campo de dominio con derivación propia —saca al nodo de los pools ready/blocked y tiene su propio bucket en el resumen (`src/providers/task/derivation.mjs:80,118-119,173-174`, `src/cli/commands/status.mjs:73`) y `add-task` lo escribe— así que entra a `task.update`; y `meta` ya es tipado en gate y knowledge, se acepta al crear en los tres kinds (`src/providers/task/create.mjs:238-244`, `src/providers/gate/create.mjs:162`, `src/providers/knowledge/create.mjs:182-190`) y lo indexa la búsqueda (`src/read-model/search.mjs:9`), así que retirarlo de `task.update` dejaría un campo escribible al crear, buscable y no editable: entra también. Si el producto prefiere un conjunto cerrado de campos de task, esa decisión es más grande que este ADR y alcanza `add-task --meta` y el índice de búsqueda.
5. **`add-note` pierde el camino sin control de revisión.** Toda nota pasa por CAS de revisión; el camino `noteCompatibilityPlan` se elimina (`src/cli/commands/add-note.mjs:61-90`), porque su única razón de ser eran las fixtures viejas que este corte elimina.
6. **`history`/`log` sin campos prehistóricos, con paridad local y remota.** Se retiran `task`, `decision` y `gotcha` de los campos de referencia (`src/cli/commands/history.mjs:6-7,15`) **y también de la ruta HTTP** (`src/server/http/reads.mjs`) y del filtro del read-model (`src/read-model/index.mjs`): si solo se cambia el adaptador local, la misma consulta devuelve resultados distintos según backend. Se define además si los filtros públicos `log --task/--decision` se retiran y cuál es su reemplazo canónico por nodo.
7. **Los errores de dispatch usan el envelope estructurado, con código de uso estable.** Unknown command y unknown flag devuelven `{ ok: false, error: { code, message, details } }` como el resto del CLI, en lugar del string histórico (`src/cli/dispatch.mjs:310-316`). El código es de uso —no `CLI_INTERNAL_ERROR`— con exit 2, y `details` incluye el comando y el flag o los flags válidos, para que un caller pueda ramificar por `error.code` sin distinguir el caso por el texto.
8. **Se eliminan los alias de módulo sin consumidor**: `parseArgs`, `dispatch` y `main` (`src/cli/dispatch.mjs:73-74,238,369-370`) dejan una sola forma de invocación.
9. **La API de plugins pasa a `1`.** `PLUGIN_API_VERSION = 1` (`src/plugins/descriptor.mjs:22`), la versión del core API expuesta al host pasa a `1`, y los descriptores y fixtures se actualizan. La política de rechazo por igualdad estricta **se mantiene**: la limpieza es de número, no de rigor.
10. **El payload de transferencia pasa a `1`.** `TRANSFER_PAYLOAD_VERSION = 1` en `src/storage/transfer.mjs` y en la validación del endpoint (`src/server/http/transfers.mjs:14`). Cliente y servidor viajan en el mismo release, así que el cambio de campo no deja versiones mezcladas. El encabezado del protocolo HTTP **no cambia**: sigue en `1` (`PROTOCOL_VERSION`), con sus operaciones, envelopes, auth y origin binding intactos.
11. **Se conserva el mecanismo de boolean flags** (`--flag=true` o después del comando), que es una regla de parsing y no un acomodo; lo que se retira es su encuadre histórico (`src/cli/dispatch.mjs:19-21`).
12. **Inventario de retiros en las notas del release.** Los flags y campos retirados se listan con su reemplazo, para que un script que hoy los pasa sepa qué hacer.

## Consecuencias

- A favor: la superficie queda sin comportamientos que el usuario no puede explicar leyendo el help; un filtro ignorado en silencio deja de ser una trampa.
- A favor: un solo número en todas las capas, coherente con el relanzamiento v1.0.0.
- En contra / deuda: cualquier script que hoy pase `--tag` a `take` o `--as` a `install` empieza a fallar. No hay consumidor externo publicado, pero sí scripts internos (`.agents/skills/*/`, `CLIMIER-CHEATSHEET.md`, el control plane): son call sites a actualizar, no autoridad sobre la superficie.
- En contra / deuda: los plugins instalados con `api: 3` dejan de cargar hasta reinstalarse o actualizarse. Con `PLUGIN_API_VERSION = 1` y rechazo estricto, el error debe explicar exactamente qué versión se espera.
- En contra / deuda: `resolve` sin la corrección histórica puede cambiar el comportamiento de un gate ya resuelto; necesita cobertura explícita antes del cambio.

## Plan de implementación

1. **Call sites internos de los retiros** — archivos: `.agents/skills/*/`, `CLIMIER-CHEATSHEET.md`, `README.md`. Grep de `--tag`, `--domain`, `--initiative` en `take`, `--as` en `install`/`uninstall`; los call sites se actualizan en esta misma slice. **Un consumidor interno no vota qué superficie queda**: si el control plane o un skill usan un flag retirado, eso se arregla ahí o se reporta como deuda de ese consumidor, pero no cambia la decisión de superficie.
2. **`take` sin filtros ignorados** — archivos: `src/cli/commands/take.mjs`, `src/cli/dispatch.mjs` (help), tests de `take`.
3. **`install`/`uninstall` sin `--as`** — archivos: `src/cli/commands/install.mjs`, `src/cli/commands/uninstall.mjs`.
4. **`resolve` sin correcciones históricas** — archivos: `src/cli/commands/resolve.mjs`, `src/providers/gate/lifecycle.mjs` si la corrección vive ahí.
5. **`update` sin `legacy_patch` y `add-note` con CAS siempre** — archivos: `src/cli/commands/update.mjs` (el inventario clave por clave que reemplaza a `PROVIDER_PATCH_KEYS`), `src/providers/task/update.mjs` (`backlog` y `meta` a la allowlist, con su validación), `src/providers/gate/update.mjs` y `src/providers/knowledge/update.mjs` (rechazo explícito de las claves que no aplican a su kind), `src/cli/commands/add-note.mjs`.
6. **`history`/`log` sin campos prehistóricos** — archivos: `src/cli/commands/history.mjs`, `src/read-model/index.mjs`.
7. **Envelope estructurado y alias fuera** — archivos: `src/cli/dispatch.mjs`, `src/contracts/errors.mjs`.
8. **API de plugins y core API en 1** — archivos: `src/plugins/api.mjs`, `src/plugins/descriptor.mjs`, `src/plugins/core-adapter.mjs`, `test/fixtures/plugins/policy-fixture/package.json`, las fixtures de descriptor, y **`docs/PLUGINS.md`**, que hoy enseña `api: 3` y `api.version === 3` y pasaría a estar desactualizado en la guía pública. El mensaje de rechazo debe decir qué versión se espera y qué debe hacer el autor para actualizar y reinstalar.
9. **Payload de transferencia en 1** — archivos: `src/storage/transfer.mjs`, `src/server/http/transfers.mjs`.
10. **Contrato de `resolve` cubierto antes del cambio** — archivos: los tests de ciclo de vida de gate, locales y remotos. Escribir primero el test del segundo `resolve` que falla con `INVALID_STATUS` en ambos caminos.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — el envelope de `release` es el que devuelve el adaptador y queda fijado por sus tests, no por lo que diga una doc; y un plugin con `api: 3` falla con un mensaje que instruye reinstalar (§Decisión 9). El inventario de `update` es trabajo de la pieza 5, no una pregunta abierta. Con esto el ADR permite crear tasks claras.
- [ ] No hace falta — por qué el ADR ya permite crear una task clara.

## Verificación

- `climier take <id> --tag x --as <agent>` falla como unknown flag y el error es el envelope estructurado.
- `climier install <pkg> --as x` falla; `climier install <pkg>` funciona.
- `resolve` sobre un gate ya resuelto se comporta de forma documentada y testeada, sin conversiones silenciosas.
- `update` con un campo desconocido falla con error claro, sin `legacy_patch`.
- `update <id> --backlog true` cambia el campo por el contrato tipado —no por el parche— y `update <id> --meta '{}'` falla como unknown flag con el envelope estructurado.
- Un plugin con `api: 3` falla con un mensaje que nombra la versión esperada (`api: 1`), y un plugin con `api: 1` carga.
- Transfer entre cliente y servidor del mismo release funciona con `version: 1` en el payload; el encabezado de protocolo sigue siendo `1`.
- `history` de un nodo no devuelve entradas por campos `task`/`decision`/`gotcha`.
