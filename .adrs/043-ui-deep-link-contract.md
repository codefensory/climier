# ADR-043: contrato de deep links de la UI y proyección pura de URLs

- Gate: `G-adr43` · Deriva de: `G-cli-urls-rfc` · Estado: borrador
- Fecha: 2026-10-08

## Contexto

El RFC (`.decisions/G-cli-urls-rfc.md`) decide que `climier urls` construye links a la UI. El CLI es stdlib-only y **no puede importar de `ui/`**: `ui/` es un subproyecto con su propio `package.json`, `node_modules` y bundler (ver `AGENTS.md` raíz, regla 1).

Las rutas de la UI viven hoy en `ui/src/modules/app-shell/data/navigation.ts` (`navPaths`, `isTaskDetailPath`, `isGateDetailPath`) y el wire del filtro en `ui/src/modules/tasks/utils/filterTreeParam.ts` (`encodeFilterTree`). Ninguno es un módulo compartido. El CLI necesita una **copia congelada** del contrato y una **guarda mecánica** contra la divergencia.

## Decisión

### 1. Contrato de rutas

Paths relativos al origen, siempre bajo el `#` del `HashRouter` (`ui/src/App.tsx`):

| id | path |
|---|---|
| `home` | `/` |
| `tasks` | `/tasks` |
| `gates` | `/gates` |
| `knowledges` | `/knowledges` |
| `initiatives` | `/initiatives` |
| `task` | `/tasks/<id>` |
| `gate` | `/gates/<id>` |
| `projects` | `/projects` |
| `knowledge` | **selección**, no detalle: `/knowledges?knowledge=<id>` |
| `gate_selection` | **selección** en `/gates?gate=<id>` (el detalle de un gate sigue siendo `/gates/<id>`) |

`projects` existe en `navPaths` pero **no** lo expone `climier urls`: no es alcanzable desde el shell y su página renderiza filas de fixture hardcodeadas (`ui/src/pages/ProjectsPage.tsx`).

### 2. Scope de proyecto

Toda URL lleva `?project=<project_id>`. El `project_id` lo resuelve el adapter (ADR-044); esta proyección sólo lo recibe.

### 3. Wire del filtro (contrato con `filterTreeParam.ts`)

```json
{"c":[{"f":"<field>","o":"<operator>","v":["<value>"]}],"g":[]}
```

`JSON.stringify` del objeto y percent-encoded como valor del param `filter`. Reglas que hacen el literal determinista:

- con `join: "and"` (default) la clave `j` **no** se emite;
- la raíz siempre incluye `g: []`;
- el orden de claves es el de `filterTreeParam.ts` (`c` antes que `g`; `f`, `o`, `v`);
- el corte CLI sólo emite la condición `f: "initiative", o: "is"`.

### 4. Composición de la URL

`url = origin + "/#" + path` y, si hay params, `+ "?" + params.toString()`. Sin params no hay `?`. El `origin` nunca termina en `/`.

### 5. Módulo y API

`src/read-model/urls.ts`, puro: sin I/O, sin argv, sin `storage/`, sin backend.

```js
buildUiUrls({ origin, projectId, initiative?, node? }) => Array<{ kind, label, url }>
```

- `node` es `{ id, kind, subkind? }` **ya resuelto** por el adapter; el módulo no lee estado ni valida.
- `kind` ∈ `home | tasks | gates | knowledges | initiatives | task | gate | knowledge`.
- Para `knowledge` la `label` aclara que es selección (`"knowledge <id> (selection in the knowledges list)"`), porque no existe ruta de detalle.
- Devuelve **sólo el array de links**. El origen, `backend`, `project_id` y `local_only` los compone el adapter (ADR-044).
- Se re-exporta desde `src/read-model/index.ts` (mismo patrón que `projectUiSnapshot`).
- Labels en inglés, igual que la UI y el resto del `HELP_TEXT`.

### 6. Frontera de contrato: fixture único

`ui/src/modules/app-shell/data/ui-url-contract.json`, con:

```json
{
  "routes": { "home": "/", "tasks": "/tasks", "gates": "/gates", "knowledges": "/knowledges", "initiatives": "/initiatives", "projects": "/projects" },
  "linked_routes": { "home": "/", "tasks": "/tasks", "gates": "/gates", "knowledges": "/knowledges", "initiatives": "/initiatives" },
  "detail": { "task": "/tasks/:id", "gate": "/gates/:id", "knowledge_param": "knowledge", "gate_param": "gate" },
  "filter_wire": {
    "initiative_plain": { "c": [{ "f": "initiative", "o": "is", "v": ["auth-migration"] }], "g": [] },
    "initiative_special": { "c": [{ "f": "initiative", "o": "is", "v": ["diseño UI/UX"] }], "g": [] }
  }
}
```

El fixture vive **dentro de `ui/`** a propósito: los tests de `ui/` corren en un navegador real (`ui/vitest.config.ts`, playwright/chromium) y no pueden leer archivos fuera del root sin configuración extra de Vite. El test del CLI lo lee con `node:fs` + `JSON.parse` (no lo importa).

Guardas (una por lado, mismo fixture):

| Lado | Archivo | Afirma |
|---|---|---|
| UI | `ui/src/modules/app-shell/data/navigation.contract.test.ts` | `navPaths` == `routes`; `isTaskDetailPath`/`isGateDetailPath` aceptan `detail.task`/`detail.gate` con un id |
| UI | `ui/src/modules/tasks/utils/filterTreeParam.contract.test.ts` | `JSON.stringify(encodeFilterTree(initiativeFilter(x)))` == `filter_wire.*` para los dos casos |
| CLI | `test/urls-projection.test.ts` | la tabla y el encoder de `src/read-model/urls.ts` == `linked_routes`, `detail` y `filter_wire` del fixture |

Cambiar un lado sin el otro hace fallar un test. Ésta es la guarda que el review pidió: no hay import posible entre lados, así que la detección de divergencia es por fixture, no por tipos.

## Consecuencias

- A favor: un único archivo define el contrato público de URLs; el CLI no gana dependencias; rutas y wire quedan cubiertos por tests que hoy no existen.
- En contra / deuda: duplicación deliberada de la tabla de rutas en el CLI; el fixture vive en `ui/` aunque lo consuma el CLI (limitación del navegador de vitest). Si la UI agrega un tercer param de selección, hay que tocar fixture + dos tests.

## Plan de implementacion

1. Fixture — `ui/src/modules/app-shell/data/ui-url-contract.json`.
2. Proyección pura + encoder — `src/read-model/urls.ts`, re-export en `src/read-model/index.ts`.
3. Test CLI contra el fixture — `test/urls-projection.test.ts`.
4. Guardas UI contra el fixture — `ui/src/modules/app-shell/data/navigation.contract.test.ts`, `ui/src/modules/tasks/utils/filterTreeParam.contract.test.ts`.

## Onboarding breve para crear tasks

- [x] Onboarding realizado:
  - **Alcance**: contrato + proyección pura + guardas. Nada de CLI, nada de red.
  - **Corte**: (a) fixture + proyección + test CLI; (b) guardas UI. Son dos tasks porque (b) toca `ui/` (runner/arnés distinto) y puede ejecutarse en paralelo con la task del comando `urls` (ADR-044) una vez que (a) mergeó. (b) depende de (a) por el fixture.
  - **Ambigüedades resueltas**: los labels son strings libres (no parte del contrato verificado); el fixture incluye `projects` en `routes` aunque el CLI no lo linkee, justamente para que el test de la UI detecte cambios en `navPaths`.

## Verificacion

- `node --test test/urls-projection.test.ts` verde (o el runner core que lo incluya).
- `(cd ui && bun run test:run)` verde.
- Prueba negativa documentada en el test: cambiar a mano el wire del encoder en el CLI hace fallar `test/urls-projection.test.ts`; cambiar `navPaths` hace fallar `navigation.contract.test.ts`.
