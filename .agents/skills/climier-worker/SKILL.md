---
name: climier-worker
description: Ejecutar una task de climier end-to-end. Hace preflight deterministico, cura la task si el contrato esta flojo, toma, implementa, verifica y resuelve.
---

# Worker protocol

La task es tu contrato. No heredas el chat del orchestrator. Si una nuance no esta en climier o en un doc referenciado por la task, no existe.

## Regla central

El worker no pide contexto largo por prompt. Lo saca de la task.

La ruta de inicio es **una sola**: `bash .agents/skills/climier-worker/start-worktree.sh <task-id> <tu-agent>`. Ese script corre la guardia de estado limpio **exactamente una vez** (`worker-guard.sh`) y luego hace `take` + `git worktree add` + nota `WORKTREE`. No invoques `worker-guard.sh` a mano antes ni despues: lo harias correr dos veces sobre el mismo estado. Si la guardia falla, el script aborta con un mensaje claro y el orchestrator debe commitear los cambios pendientes antes de reintentar.

Ruta rapida obligatoria: usa los scripts empaquetados para procesos repetitivos. No repitas manualmente sus pasos internos (`git status`, resolver `project_root`, `take`, `context`, `git worktree add`, `add-note WORKTREE`, `resolve`) salvo que sea estrictamente necesario por un fallo concreto del script o una task de recuperacion que lo pida explicitamente. Si haces una excepcion, deja un handoff corto explicando por que el script no aplicaba.

Orden de autoridad:

1. `climier context <id>`
2. `climier show <id>`
3. gates dependientes (resoluciones via `climier resolve <G>`)
4. knowledge scope (knowledge via `climier search` / `context` matching scopes)
5. docs referenciados (`.decisions/`, `docs/`)
6. contexto minimo del repo

Si el body referencia un ADR (`./.adrs/NNN-*.md`), ese ADR + los archivos listados en el body son tu contexto de diseno completo. Lee el ADR (o solo la seccion indicada) y no explores otros ADRs ni el resto del repo salvo que el codigo que tocas lo exija.

## Inicio rapido

La ruta default debe ser barata. No hagas bundle pesado si la task se entiende con los comandos base:

```bash
climier context <task-id>
bash .agents/skills/climier-worker/start-worktree.sh <task-id> <tu-agent>
```

`start-worktree.sh` es el unico punto de entrada. Corre la guardia de estado limpio, valida que no exista la rama/path, hace `take`, crea el worktree, registra la nota `WORKTREE ... status=started` (con `path`, `branch`, `base`, `base_ref`, `base_sha`) e imprime el `cd` siguiente. No vuelvas a correr esos comandos a mano ni invoques `worker-guard.sh` por separado.

Cada llamada independiente a la herramienta shell puede arrancar en el root del
proyecto: un `cd` de una llamada no persiste en la siguiente. Guarda el path que
imprime el script y antepone `cd <worktree> &&` a cada comando posterior, o usa
paths absolutos. Antes de editar o testear, confirma `pwd` y la rama dentro de
ese mismo comando. Nunca ejecutes tests desde el worktree principal.

Los tests deben ser acotados y tener timeout explícito y con kill de respaldo
(`timeout -k 10s 180s ...`). No uses `node --test --test-skip-pattern=ui- test/*.test.mjs` para excluir archivos UI: `--test-skip-pattern` filtra nombres de tests, no nombres de archivo. Usa el script `npm test` verificado por el
repo o una lista explícita de archivos; si un comando no produce salida durante
el timeout, detenlo y deja handoff en vez de mantener la task en `running`
indefinidamente.

### Presupuesto operativo y checkpoints

El límite de turns del agente no es un límite confiable de comandos. Cuenta las
llamadas de shell y aplica este presupuesto: checkpoint después de 10 llamadas,
implementación y primer test antes de 20, y cierre o handoff antes de 30 salvo
que el orchestrator haya documentado una excepción. No releas el repo completo,
no repitas suites ya verdes y no mantengas dos verificaciones activas. Si el
scope no entra, deja el cambio mínimo commiteado o un handoff preciso y libera;
no sigas explorando hasta consumir el contexto.

Usa `task-context.sh` solo cuando necesites compactar contexto disperso:

- la task menciona gates o docs
- `context` no basta para saber que tocar
- estas haciendo handoff o audit de contrato
- quieres detectar gaps obvios antes de curar la task

```bash
bash .agents/skills/climier-worker/task-context.sh <task-id>
```

El modo default del script es liviano:

- detecta el project root canonico desde git worktree
- corre `context` y `show` contra ese root una sola vez
- lista gates dependientes y docs referenciados
- marca gaps obvios del contrato (`acceptance missing`, `skills missing`, etc.)
- termina con veredicto `GO` o `NO-GO`
- no imprime el contenido completo de docs

Para contexto pesado, pidelo explicitamente:

```bash
bash .agents/skills/climier-worker/task-context.sh <task-id> --docs
bash .agents/skills/climier-worker/task-context.sh <task-id> --full
```

Regla anti-duplicacion: si corriste `task-context.sh`, no vuelvas a correr manualmente `context` ni `show` sobre el mismo estado. Usa su output como snapshot. Si corriste `--docs` o `--full`, tampoco releas todos los docs incluidos; solo abre archivos puntuales si necesitas inspeccionar lineas concretas para implementar.

No hagas rituales de `pwd`, `cd` manual ni rutas copiadas a mano. El script ya resuelve la parte fragil.

## Preflight

La preflight es de **lectura**: solo inspecciona el contrato de la task, no muta nada. El unico script que corre la guardia de estado limpio es `start-worktree.sh`; no la invoques a mano.

Secuencia fija:

1. corre `climier context <id>` desde el root del proyecto (descubre el proyecto por CWD)
2. si el contrato esta disperso, corre `bash .agents/skills/climier-worker/task-context.sh <id>` y no repitas manualmente lo que el script ya hizo
3. lee el veredicto (derived_status + can_claim + allowed_actions)
4. si ves un gap objetivo y la task sigue `ready`, corrige la task con `climier --project . update <id> --as <tu-agent> ...` (el CLI descubre el proyecto desde CWD; no necesitas resolver `project_root` a mano)
5. vuelve a correr solo el comando que valida el cambio (`context` o `task-context.sh`, no ambos salvo necesidad)
6. recien ahi llama `bash .agents/skills/climier-worker/start-worktree.sh <id> <tu-agent>`; no tomes ni crees el worktree a mano, y no corras `worker-guard.sh` por separado

El preflight termina rapido. Objetivo: saber que tocar, que no tocar, como verificar, y si el contrato esta lo bastante curado para ejecutarse. La guardia de estado limpio la corre `start-worktree.sh` y solo `start-worktree.sh`.

## Cuando curar la task

Antes del `take`, usa `climier --project . update <id> --as <tu-agent> ...` si el problema es objetivo:

- paths viejos
- doc faltante pero claramente referido por la spec
- acceptance floja pero deducible de la misma spec o gate
- domain, tags, refs o meta desalineados (skills/effort/priority no existen en el modelo; van en --body o --meta)
- restriccion ya conocida que deberia vivir en body, notes o scope de knowledge

Despues de `update`, vuelve a correr solo el comando que estabas usando para validar el contrato (`context` o `task-context.sh`).

No cures metadatos menores. Si la task es entendible y tomable, trabaja. Cura solo si el gap cambia que tocar, como verificar o si la task deberia ser `NO-GO`.

No cures producto ni negocio por tu cuenta. Si falta una decision real:

```bash
climier --project . add-note <id> "NO-GO preflight: <problema exacto>. Necesito que orchestrator decida o cure <X>." --as <tu-agent>
```

Y no tomes.

## Take y ejecucion

Cuando el preflight diga `GO`:

1. `bash .agents/skills/climier-worker/start-worktree.sh <id> <tu-agent>`
2. entra al path que imprime el script
3. trabaja solo dentro de ese worktree
4. haz el diff minimo necesario
5. deja `climier --project . add-note` solo cuando descubras algo que otro worker pagaria por reaprender

Regla dura de aislamiento: el worker nunca modifica `main` ni el worktree principal. Tiene prohibido hacer `merge`, `pull`, `rebase`, `reset`, `commit`, `checkout` o `switch` sobre `main`; tampoco puede traer su rama de task a `main`, actualizar `main` ni corregir archivos desde el arbol principal. Todo cambio de implementacion, verificacion y commit vive exclusivamente en el worktree/rama de la task. La integracion con `main` queda fuera del worker y pertenece al validador/orchestrator.

El script `start-worktree.sh` usa el `main` actual como base solo para capturar `base_ref` + `base_sha` inmutables; nunca muta `main`.

Este protocolo asume que recibiste una task de Climier ya preparada para delegacion. No decidas por tu cuenta cambiar su modelo de ejecucion ni uses el worktree principal.

`start-worktree.sh` es la ruta default para claim y worktree:

```bash
bash .agents/skills/climier-worker/start-worktree.sh <id> <tu-agent>
```

No recrees manualmente `base_branch`, `worktree_path`, `worktree_branch`, `git worktree add` ni la nota `WORKTREE` si este script aplica.

Si la task de correccion dice "continue in existing worktree", no crees otro. Entra al path/rama indicado y agrega nota `WORKTREE ... status=fix-started`.

## Aislamiento de smokes

Si necesitas ejecutar un comando mutante de Climier sobre un proyecto temporal — `init`, `init --force`, `add-task`, `take`, `resolve`, etc. — para verificar comportamiento, **usa siempre** el helper:

```bash
bash .agents/skills/climier/smoke-sandbox.sh -- <comando> [args...]
```

El helper crea un `CLIMIER_HOME` privado bajo `/tmp`, aplica `umask 077`, propaga stdout/stderr/exit y limpia en `EXIT`/`HUP`/`INT`/`TERM`. Un residual tras `SIGKILL` es aceptable porque vive fuera del home real.

**Prohibido** ejecutar `init`, `init --force` o cualquier mutación de smoke sobre un proyecto temporal sin el helper. Copiar `.climier.json` a un temporal sin el sandbox reusa la pizarra real y puede reemplazar el estado activo. Lo mismo aplica si solo querés validar `climier status`/`context` sobre metadata copiada: si la mutación no toca el home real, no es sandbox, pero si dudás, usá el helper.

Si tu verificación es read-only contra un proyecto temporal sin metadata, podés invocar `climier --project <tmp>` directamente; no hace falta sandbox si no hay mutación ni metadata compartida.

## Verificacion

Antes de `done`, verifica la acceptance real de la task. Elige el menor check que pruebe el contrato:

| Tipo de cambio | Verificacion default |
|---|---|
| Solo docs Markdown | revisar diff; no correr build/lint |
| Shell scripts | `bash -n <script>` y, si no es destructivo/largo, modo `--help` o dry-run |
| JSON/package scripts | `node -e 'JSON.parse(...)'` o `npm pkg get ...`; probar solo el script si es rapido/no destructivo |
| TS/JS local a un paquete | typecheck/lint/test del paquete tocado, no necesariamente raiz |
| APIs compartidas, auth, rutas productivas, DB/migrations | checks de paquete o repository segun blast radius |

Checks de raiz solo cuando aplican al blast radius:

- `npm run typecheck` en la raiz si el cambio afecta tipos compartidos, exports, imports transversales o varios paquetes
- `npm run lint` en la raiz si el cambio afecta codigo lintable en varios paquetes o la task lo pide
- cualquier test o comando pedido explicitamente en `acceptance` o `definition`

Si la verificacion falla, no hagas `done`.

## Commit obligatorio

Antes de `done`, commitea todos los cambios de la task dentro del worktree. Esto es obligatorio: el validador solo revisa branches con commits, no diffs sueltos.

Reglas:

- un commit debe cerrar exactamente una task
- el mensaje debe terminar con `[<task-id>]`
- no dejes cambios staged, unstaged ni untracked sin justificar
- si es una task de correccion sobre el mismo worktree, agrega un nuevo commit sobre la rama existente
- no mergees, no commitees en `main` y no cambies de vuelta al worktree principal para arreglar archivos

Formato:

```bash
git status --short
git add <paths>
git commit -m "<summary> [<task-id>]"
git status --short
```

Si `git status --short` no queda limpio, no hagas `resolve` salvo que la nota explique exactamente por que esos archivos quedan fuera del commit.

## Cierre

`finish-task.sh` es obligatorio para cerrar. No ejecutes `climier add-note ... status=ready-for-validation` ni `climier resolve <id> --note "..."` a mano si este script aplica.

El script valida antes de cerrar:

- `git status --short --untracked-files=all` debe estar limpio
- el ultimo commit debe existir en el worktree actual
- el mensaje del ultimo commit debe terminar con `[<task-id>]`

Si hay cambios pendientes, staged, unstaged o untracked, `finish-task.sh` falla y el worker debe volver a hacer commit antes de finalizar. No hace `git add`, no hace `git commit` y no corrige mensajes por su cuenta.

Solo cierra cuando:

- el trabajo pedido esta hecho
- la acceptance quedo cubierta
- el `resolve --note` explica que se shippeo y que se verifico
- todos los cambios de la task estan commiteados en la rama del worktree
- el commit message termina con `[<task-id>]`
- dejaste nota `WORKTREE ... status=ready-for-validation`
- no mergeaste la rama al worktree principal ni modificaste `main`

```bash
bash .agents/skills/climier-worker/finish-task.sh <id> <tu-agent> "<que shippeaste; que verificaste>"
```

No repitas manualmente `git rev-parse HEAD`, la nota `WORKTREE ... status=ready-for-validation` ni `climier resolve <id> --note "..."` si `finish-task.sh` corrio bien.

Despues de cada worker, el siguiente paso del flujo es obligatorio: ejecutar un validador independiente con `climier-validator` sobre la task cerrada. El worker no se valida a si mismo, no corrige durante esa validacion y no mergea. Si el validador falla, entrega un reporte al orchestrator para crear una nueva task de correccion sobre el mismo worktree/rama.

## Si te trabas

Si ya tomaste y aparece un bloqueo real:

1. `climier --project . add-note <id> "<que intentaste>; <que encontraste>; <decision tactica o bloqueo>" --as <tu-agent>`
2. `climier --project . release <id> --as <tu-agent>` para liberar el claim y permitir que el orchestrator o otro worker siga
3. devuelve un handoff concreto al orchestrator

Formato:

```text
<task-id>: bloqueada.
Intente: <approach, archivos, comandos>.
Encontre: <bloqueo exacto>.
Necesito: <decision, spec update, secreto, dependencia>. Resume recomendado: si/no.
```

> climier no tiene `block`. La escalacion es `add-note "<id>" "blocked: ..."` + `release` + handoff al orchestrator. El orchestrator puede reabrir la task (`update`), resolver el gate que la bloquea (`resolve <G>`), o asignar otro worker.

## Firmas de CLI y mutaciones raras

Si vas a usar un comando mutante poco frecuente porque la spec lo pide, primero valida la firma exacta con `--help`. No asumas.

Casos que se olvidan facil:

- `climier resolve <id> --note "<text>" --as <agent>` (task) — `--note` es flag obligatorio
- `climier resolve <G> --choice "<x>" --rationale "<y>" --as <agent>` (gate) — `--choice` y `--rationale` son flags obligatorios
- `climier reopen <id> --reason "<text>" --as <agent>` — `--reason` es flag obligatorio
- `climier cancel <id> --reason "<text>" --as <agent>` — `--reason` es flag obligatorio
- `climier deprecate-knowledge <id> --reason "<text>" --as <agent>` — `--reason` es flag obligatorio
- `climier update <id> ... --as <agent>` — usar `--if-revision N` para concurrency si hay varios editores

## Hard rule: no DDL destructivo

Si la task te empuja a `DROP`, `TRUNCATE`, `DELETE FROM` sin `WHERE`, `DROP SCHEMA`, `DROP DATABASE` o un reset destructivo fuera del scope literal de la task: no lo ejecutes.

Deja nota y libera el claim:

```bash
climier --project . add-note <id> "Iba a ejecutar <comando>; no lo hice porque excede el scope o es destructivo." --as <tu-agent>
climier --project . release <id> --as <tu-agent>
```

La excepcion tiene que estar escrita de forma literal en la spec.
