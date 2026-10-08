# ADR-044: `climier urls` — origen, validación y superficie read-only

- Gate: `G-adr44` · Deriva de: `G-cli-urls-rfc` · Estado: borrador
- Fecha: 2026-10-08

## Contexto

El RFC (`.decisions/G-cli-urls-rfc.md`) aprueba un comando read-only que devuelve deep links de la UI. ADR-043 fija el contrato de URLs y `buildUiUrls()` en `src/read-model/urls.ts`. Falta decidir el adapter: de dónde sale el origen, qué se valida, qué forma tiene la salida y cómo se cablea en el CLI.

Datos del repo que mandan:

- `climier ui` (`src/cli/commands/ui.ts`) levanta la UI en `127.0.0.1:7373` (`DEFAULT_PORT`, `LOOPBACK_HOST`) sin auth; `uiCommand` ya devuelve `{ ui: { url, project, state_file, read_only } }`.
- En un proyecto linkeado, `.climier.json` tiene `backend: { type: "remote", url }`, parseado por `parseBackendConfig` (`src/application/backend-config.ts`), y el server sirve la misma UI en la raíz de ese origen (`docs/remote-server.md` § "Serving the web UI").
- El id que la UI usa en `?project=` **no** es el mismo resolutor en los dos backends:
  - local: `listProjectIds()` lista los directorios de `CLIMIER_HOME/projects/`; el id es `path.basename(path.dirname(stateFile(projectDir)))` (igual que `localProjectId` en `src/cli/commands/ui.ts`), que a su vez es el `project_id` de `.climier.json` o el sha1 default de `src/storage/state.ts`.
  - remoto: el `project_id` de `.climier.json`, que es el id del catálogo del server.

## Decisión

### 1. Superficie

```
climier urls [--initiative X] [--id NODE] [--port N] [--origin URL]
```

- Read-only: no requiere `--as`, no muta, no pasa por el kernel.
- Cero posicionales: cualquier posicional es `CLI_USAGE_ERROR`.
- `--initiative` y `--id` son mutuamente excluyentes. `--origin` y `--port` son mutuamente excluyentes (el puerto sólo aplica al origen local por defecto).
- `--initiative ""` / `--id ""` → `CLI_USAGE_ERROR`.

### 2. Resolución del origen

En orden:

1. `--origin URL`: absoluta `http(s)`, sin credenciales, sin `search` ni `hash`; se normaliza a `new URL(value).origin`. `backend: "remote"` y `local_only: false`.
2. `.climier.json` con `backend.type === "remote"`: se usa `backend.url` (vía `parseBackendConfig`). `backend: "remote"`, `local_only: false`.
3. `http://127.0.0.1:<port>` con `port` default `7373` (el default de `climier ui`) u override `--port N`, validado como entero en `1..65535`. `backend: "local"`, `local_only: true`. `--port 0` se rechaza: `climier ui --port 0` deja que el SO asigne un puerto efímero que sólo se conoce después de arrancar, y `urls` no arranca ni sondea el server.

El comando **no** levanta, administra ni sondea el server local, y no abre el browser.

### 3. Resolución del `project_id`

- local: `path.basename(path.dirname(stateFile(projectDir)))`.
- remoto: `projectConfig.project_id`.

### 4. Validación de `--initiative` / `--id`

| Backend | Lectura | Error si no existe |
|---|---|---|
| local | `readState(statePath)` | `INITIATIVE_NOT_FOUND` / `NODE_NOT_FOUND` |
| remoto | `backendClient.readInitiatives({ all: true })` / `backendClient.readNode({ id })` | `INITIATIVE_NOT_FOUND` / `NODE_NOT_FOUND` |

En remoto se valida **sólo contra el backend remoto**; nunca contra un `tasks.json` local (puede no existir o estar stale).

Sin flags no se lee ni se valida nada: la lista base de vistas es válida aunque el estado esté vacío o el proyecto no esté inicializado (la UI resuelve ese caso con `ProjectStatePage`).

### 5. Salida

Read command → data cruda, un único `{ ui: ... }`:

```json
{
  "ui": {
    "origin": "http://127.0.0.1:7373",
    "backend": "local",
    "project_id": "9f1c...",
    "local_only": true,
    "urls": [
      { "kind": "home", "label": "home", "url": "http://127.0.0.1:7373/#/?project=9f1c..." },
      { "kind": "tasks", "label": "tasks", "url": "http://127.0.0.1:7373/#/tasks?project=9f1c..." },
      { "kind": "gates", "label": "gates", "url": "http://127.0.0.1:7373/#/gates?project=9f1c..." },
      { "kind": "knowledges", "label": "knowledges", "url": "http://127.0.0.1:7373/#/knowledges?project=9f1c..." },
      { "kind": "initiatives", "label": "initiatives", "url": "http://127.0.0.1:7373/#/initiatives?project=9f1c..." }
    ]
  }
}
```

Regla de composición del array, sin casos especiales: **siempre** la lista base (`home`, `tasks`, `gates`, `knowledges`, `initiatives`, en ese orden) más los links del flag, al final:

- `--initiative X`: `+ { kind: "tasks", label: "tasks of initiative 'X'", url: .../#/tasks?...&filter=<wire> }`.
- `--id NODE`: `+ { kind: "task"|"gate"|"knowledge", label: ..., url }`, con la ruta de detalle para task/gate y `?knowledge=<id>` (selección) para knowledge, con la `label` aclarando la diferencia.

### 6. Wiring

- `src/cli/commands/urls.ts` con `knownFlags = ["initiative", "id", "port", "origin"]` (el `validateKnownFlags` de `src/cli/dispatch.ts` ya rechaza flags desconocidos).
- `src/cli/dispatch.ts`: entrada en `COMMANDS`, en `KNOWN_COMMANDS` y en `REMOTE_SUPPORTED_COMMANDS`; ayuda en `HELP_TEXT` (read-only, con la aclaración de que un origen `local_only` sólo sirve en esa máquina mientras `climier ui` corre).
- `src/cli/commands/reserved-namespaces.ts`: `urls`.
- `README.md` (sección Read-only) y `docs/reference.md`: misma entrada que `ui`, en una línea.

### 7. Fuera de alcance

- Filtro por iniciativa en gates y knowledges (hueco conocido: `useGatesUrl`/`useKnowledgesUrl` no tienen ese param y `query` matchea sólo title/id).
- Abrir el browser, levantar/sondear el server, login remoto, cambios de producto en la UI.

## Consecuencias

- A favor: el deep link deja de ser conocimiento tribal; `--origin` permite compartir un origen accesible y `local_only` avisa cuando el link no lo es; el camino remoto valida contra el DAG que la UI realmente muestra.
- En contra / deuda: `urls` entra a `REMOTE_SUPPORTED_COMMANDS`, así que cada read remoto nuevo (hoy `readInitiatives`/`readNode`) se vuelve parte del contrato del comando; y el puerto local es una suposición declarada, no una verdad verificada.

## Plan de implementacion

1. Adapter `urls` + flags/validación/origen/resolución de `project_id` — `src/cli/commands/urls.ts` (usa `buildUiUrls` de ADR-043).
2. Wiring — `src/cli/dispatch.ts`, `src/cli/commands/reserved-namespaces.ts`, `README.md`, `docs/reference.md`.
3. Test de integración del comando — `test/urls.test.ts` con `runCliInProcess` de `test/cli-harness.ts` (harness local) y el patrón remoto de `test/cli-remote-read-routing.test.ts`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado:
  - **Alcance**: un adapter + wiring + un test de integración. La proyección pura ya está en la task de ADR-043.
  - **Corte**: una sola task. No se parte porque el wiring sin adapter no tiene comportamiento observable y viceversa; el acceptance cubre ambos.
  - **Ambigüedades resueltas**: la lista base siempre está presente (regla única); `local_only` es booleano y no un string libre; los errores de `.climier.json` los emite `parseBackendConfig` (`REMOTE_CONFIG_OUTDATED`, etc.) y no se re-envuelven.

## Verificacion

- `node --test test/urls.test.ts` verde.
- Comportamiento observable, todos en `test/urls.test.ts`:
  - proyecto local inicializado: `urls` devuelve 5 links base con `backend: "local"`, `local_only: true` y `?project=` presente en cada uno;
  - `--initiative <nombre con espacios/UTF-8>`: 6 links, el último con `kind: "tasks"` y el `filter` percent-encoded que el fixture de ADR-043 fija;
  - `--id` sobre task, gate y knowledge: `kind`/ruta correctos, y la `label` de knowledge dice selección;
  - `--initiative` inexistente → `INITIATIVE_NOT_FOUND`; `--id` inexistente → `NODE_NOT_FOUND`; `--port 0`, `--port abc`, `--origin` con `--port`, `--initiative` con `--id`, y un posicional → `CLI_USAGE_ERROR`;
  - proyecto con `backend.type === "remote"`: origen = `backend.url`, `local_only: false`, y la validación usa `readInitiatives`/`readNode` del backend (sin tocar el state local).
