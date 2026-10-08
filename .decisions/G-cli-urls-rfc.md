# RFC: `climier urls` — deep links de la UI como salida de primera clase

- Gate: `G-cli-urls-rfc` · Iniciativa: `cli-urls` · Estado: en review
- Autor: pi-orchestrator · Fecha: 2026-10-08

## Problema

La UI ya tiene deep links completos, pero nadie los expone.

- El router es un HashRouter, así que todo el estado de navegación es shareable: `ui/src/App.tsx` monta `HashRouter`, y `ui/src/modules/app-shell/data/navigation.ts` (`navPaths`) fija las rutas `/`, `/tasks`, `/gates`, `/knowledges`, `/initiatives`, `/projects`, más el detalle `/tasks/:id` y `/gates/:id` (`ui/src/pages/index.ts`).
- El estado de presentación también vive en la URL: `ui/src/modules/tasks/controllers/useTasksUrl.ts` (`?view=`, `?scope=`, `?sort=`, `?group=`, `?filter=`), `useGatesUrl.ts` (`?status=`, `?query=`, `?group=`, `?gate=`), `useKnowledgesUrl.ts` (`?knowledge=`), y `?project=<id>` en `ProjectProvider` (`ui/src/modules/app-shell/providers/ProjectProvider.tsx`).
- El filtro por iniciativa ya está resuelto en la UI: `InitiativesPage.openInitiative()` arma `#/tasks?filter={"c":[{"f":"initiative","o":"is","v":["<nombre>"]}]}` con `encodeFilterTree` (`ui/src/modules/tasks/utils/filterTreeParam.ts`). Hay una story que lo verifica (`InitiativesPage.stories.tsx`, `OpensFilteredTasks`).

O sea: el "cómo llegar" existe, pero para usarlo hay que conocer el wire del filtro, la ruta exacta y el origen. Un agente que lee `climier status` no tiene forma de obtener ese link, y el humano termina reconstruyendo la URL a mano.

El origen tampoco es obvio:

- **Local**: `climier ui` (`src/cli/commands/ui.ts`) levanta la UI en `127.0.0.1:7373` (`DEFAULT_PORT`/`LOOPBACK_HOST`) sin auth y sirve el mismo contrato `/v1`. Sólo responde mientras ese proceso vive.
- **Remoto**: en un proyecto linkeado, el server sirve la UI compilada en la raíz del `backend.url` de `.climier.json` con SPA fallback (`docs/remote-server.md` § "Serving the web UI"; `src/server/runtime.ts` `DEFAULT_UI_ROOT`; `src/server/http.ts` static handler). El contrato del hash es el mismo.

## Propuesta

Un comando read-only `climier urls` que resuelve el origen y devuelve URLs absolutas clickeables, construidas desde una proyección pura.

```
climier urls                      # raíz del workspace + vistas
climier urls --initiative X       # página de iniciativas + board filtrado por X
climier urls --id T-1             # detalle del nodo, según su kind
climier urls ... [--port N] [--origin URL]
```

Salida (read command → data cruda, un solo `{ ui: ... }`):

```json
{
  "ui": {
    "origin": "http://127.0.0.1:7373",
    "backend": "local",
    "project_id": "<project_id de .climier.json>",
    "local_only": true,
    "urls": [
      { "label": "tasks de la iniciativa 'auth-migration'", "kind": "tasks", "url": "http://127.0.0.1:7373/#/tasks?project=<id>&filter=%7B%22c%22%3A%5B%7B%22f%22%3A%22initiative%22%2C%22o%22%3A%22is%22%2C%22v%22%3A%5B%22auth-migration%22%5D%7D%5D%2C%22g%22%3A%5B%5D%7D" },
      { "label": "iniciativas", "kind": "initiatives", "url": "http://127.0.0.1:7373/#/initiatives?project=<id>" }
    ]
  }
}
```

Resolución de origen, en orden:

1. `--origin URL` (gana siempre; valida `http(s)` absoluta). Es mutuamente excluyente con `--port`.
2. `backend.url` de `.climier.json` cuando `backend.type === "remote"` (`parseBackendConfig`, `src/application/backend-config.ts`).
3. `http://127.0.0.1:<port>`, con `port` default 7373 (el mismo default de `climier ui`) y override `--port N`, validado como entero en `1..65535`.

`--port 0` se rechaza con `CLI_USAGE_ERROR`: `climier ui --port 0` deja que el sistema asigne un puerto efímero que sólo se conoce después de arrancar, y `urls` no arranca ni sondea el server; emitir `:0` sería un link imposible.

`local_only` es `true` cuando el origen se resolvió por el camino 3 (loopback): el link sirve únicamente en esa máquina y mientras `climier ui` esté corriendo. El `HELP_TEXT` lo dice explícitamente.

`project_id` es el id que la UI usa en `?project=`, y **no** es el mismo resolutor en los dos backends:

- local: el nombre del directorio de estado bajo `CLIMIER_HOME/projects/<id>` (`path.basename(path.dirname(stateFile(projectDir)))`, igual que `localProjectId` en `src/cli/commands/ui.ts`), que es lo que lista `/v1/projects` del server local.
- remoto: `projectConfig.project_id` de `.climier.json`, que es el id del catálogo del server.

Catálogo de URLs del corte:

| Flag | URLs |
|---|---|
| (ninguno) | `/`, `/tasks`, `/gates`, `/knowledges`, `/initiatives` |
| `--initiative X` | las anteriores + `/tasks?filter=<initiative X>` |
| `--id NODE` | `/tasks/<id>` si es task, `/gates/<id>` si es gate, `/knowledges?knowledge=<id>` si es knowledge |

Todas llevan `?project=<project_id>`. Cada entrada de salida lleva `kind` (`home`, `tasks`, `gates`, `knowledges`, `initiatives`, `task`, `gate`, `knowledge`) y una `label` que distingue el destino. En particular, para un knowledge el link **no es una página de detalle** (no existe ruta `/knowledges/:id`): selecciona el nodo en el panel de la lista (`?knowledge=<id>`), y la `label` lo dice.

`/projects` queda **fuera** del catálogo a propósito: existe en `navPaths` pero no es alcanzable desde el shell y su página renderiza filas de fixture hardcodeadas (`ui/src/pages/ProjectsPage.tsx`), así que linkearla sería ofrecer una página muerta.

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| A. Sumar campos `url` a `status`/`context` | cero superficie nueva; el consumidor ya tiene el snapshot | mete presentación web (origen, backend) dentro de la proyección de DAG, que es pura (`src/read-model/`); obliga a resolver backend/origen en cada read; no expresa links de iniciativa ni de nodo; rompe el contrato "read-model puro" |
| B. Comando `urls` + proyección pura (recomendada) | read-model puro testeable con datos literales; adapter delgado; un único lugar para la tabla de rutas; cubre local y remoto; reusa `parseBackendConfig` | superficie nueva que documentar; el wire del filtro se duplica del lado CLI (el CLI es stdlib-only y no puede importar de `ui/`) |
| C. Extender `climier ui --print-url` | reusa el comando que ya conoce la URL (`uiCommand` ya devuelve `ui.url`) | `ui` levanta server y abre browser; sólo cubre la raíz local; no puede expresar deep links a iniciativa/nodo; en remoto no aplica (allí no se corre `ui`) |

## Alcance

- **Dentro**:
  - Comando read-only `climier urls` (`src/cli/commands/urls.ts`), sin `--as`.
  - Proyección pura de URLs (`src/read-model/urls.ts`) con la tabla de rutas y el encoder mínimo del filtro.
  - Resolución de origen local/remoto según `.climier.json` + `--origin`/`--port`.
  - `?project=<project_id>` siempre presente en cada URL.
  - `--initiative X`: valida que X exista en el snapshot (`INITIATIVE_NOT_FOUND` si no) y produce el board filtrado.
  - `--id NODE`: valida el nodo (`NODE_NOT_FOUND`) y elige la ruta por `kind`/`subkind`.
  - Soporte remoto: agregar `urls` a `REMOTE_SUPPORTED_COMMANDS` en `src/cli/dispatch.ts`; validar contra el DAG del server (`readInitiatives`/`readNode`), no contra un state local stale.
  - Wiring: `KNOWN_COMMANDS`, `HELP_TEXT`, `RESERVED_NAMESPACES`, README.
  - Frontera de contrato explícita: un fixture único `test/fixtures/ui-url-contract.json` con las rutas fijas, las de detalle, los params de selección y el wire del filtro, consumido por un test del lado CLI (`test/urls-projection.test.ts`) y otro del lado UI (`navigation.contract.test.ts` + `filterTreeParam.contract.test.ts`). Si cualquiera de los dos lados cambia el contrato, uno de los tests falla.
- **Fuera**:
  - Filtro por iniciativa en `gates` y `knowledges`: hoy `useGatesUrl`/`useKnowledgesUrl` sólo tienen `status`, `query`, `group` y `selection`, y `query` matchea title/id, no la iniciativa. Se decidió no cerrarlo en este corte.
  - Abrir el browser, levantar/administrar/sondear el server local.
  - Auth remoto (la UI muestra `LoginPage` si el browser no tiene sesión; el CLI no lo resuelve).
  - Cualquier cambio de producto en la UI, salvo el test de fixture que fija el wire.

## Riesgos y open questions

- **El wire del filtro es contrato implícito de la UI** (`filterTreeParam.ts`). Si la UI cambia su encoder, el CLI se desincroniza en silencio y los links abren un board sin filtro (el decoder descarta condiciones inválidas). → ADR-043: congelar rutas y wire en un fixture único y cubrirlo con un test de contrato en cada lado.
- **La URL local sólo responde con `climier ui` corriendo.** El comando no debe levantar nada ni sondear puertos. → `backend: "local"` + `local_only: true` + default de puerto; `--port` refleja un `climier ui --port N`.
- **En remoto la UI pide credenciales en el browser** aunque el CLI tenga token válido. → documentar; no es responsabilidad del comando.

Decisiones de cierre (resueltas tras el review):

- ¿`urls` sin flags? Sí: raíz + vistas del workspace. Es el caso más útil para "abrí el board de este proyecto" y no requiere leer nodos.
- URL absoluta, no fragmento relativo: un solo campo `url` clickeable (el `href` relativo es ruido para el caso de uso).
- `--initiative` y `--id` juntos → `CLI_USAGE_ERROR` (mutuamente excluyentes).
- `--origin` y `--port` juntos → `CLI_USAGE_ERROR` (el puerto sólo aplica al origen local por defecto).
- `--id` sobre un knowledge → `?knowledge=<id>` con `kind: "knowledge"` y label que aclara que es selección, no detalle.
- La tabla de rutas del CLI es una **copia congelada** del contrato público de la UI, no una derivación en runtime (el CLI es stdlib-only y no puede importar de `ui/`). La guarda es el fixture compartido, no un import.

## Review

Tres lentes, una nota consolidada cada una (`G-cli-urls-rfc`), sin bloqueos. Preguntas y sugerencias atendidas en este doc:

- **arquitectura**: `--port 0` y rango de puerto → decidido `1..65535` + exclusión mutua con `--origin`; duplicación de `navPaths` y omisión de `/projects` → frontera de contrato con fixture único y omisión documentada.
- **ejecucion**: dónde vive el fixture y qué lo consume → `test/fixtures/ui-url-contract.json`, con un test por lado; corte de tasks en cuatro piezas con dependencias reales (§ADRs derivados).
- **producto**: `--id` sobre knowledge no es una página de detalle → `kind`/`label` explícitos; el link local no es compartible → `local_only` + `HELP_TEXT`.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-043: contrato de deep links de la UI y proyección pura de URLs → `.adrs/043-ui-deep-link-contract.md`
- [ ] ADR-044: `climier urls` — origen, validación y superficie read-only → `.adrs/044-climier-urls-command.md`
