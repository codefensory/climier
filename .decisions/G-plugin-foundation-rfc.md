# RFC: Climier Plugin Foundation

- Gate: `G-plugin-foundation-rfc` · Iniciativa: `plugin-foundation` · Estado: en review
- Autor: usuario + orchestrator · Fecha: 2026-08-31

## Problema

Climier ya tiene providers, una única frontera de mutación y una API de plugins,
pero aún conserva semántica propia de ejecución (`meta.execution` y conflictos de
ownership), un bypass `task.resolve` a `done`, revisiones por nodo sin una versión
global, y lecturas de plugin que deben componerse desde llamadas independientes.
Tampoco puede aplicar una reparación multioperación del DAG como una transacción.

Un execution plugin futuro debe poder leer un grafo coherente, decidir fuera del
core y aplicar una reparación condicionada a esa lectura. El core no debe adoptar
conceptos de harnesses, scheduling, ownership de paths, workers, validators ni
artifacts de ejecución para lograrlo.

## Propuesta

Preparar el core y su superficie pública con estas garantías acotadas:

1. retirar toda interpretación de `meta.execution` y eliminar el bypass
   `task.resolve`; el único camino de una task a `done` será
   `take → submit → accept`;
2. centralizar la invariantes del estado, incluido que `BLOCKS` sea acíclico, y
   añadir una revisión global monotónica con CAS;
3. exponer `edge.remove` y un `batch` declarativo que aplica operaciones del
   catálogo sobre un único draft y persiste una vez o no persiste;
4. exponer una lectura coherente y determinista del core más el namespace del
   plugin llamante, tanto por Plugin API como por CLI;
5. endurecer plugin data a valores JSON seguros, con delete explícito y
   aislamiento de namespace;
6. proporcionar un directorio runtime estable y aislado por proyecto/plugin;
7. versionar explícitamente la Plugin API y probar la frontera con un fixture
   que no importe módulos internos.

La revisión global es semántica requerida para CAS, así que el schema sube de v3 a
v4. La migración v3→v4 inicializa `revision: 0`; cada commit efectivo posterior
la incrementa exactamente una vez. Estados v2 siguen migrando a través de v3.
La revisión por node se conserva como CAS fino para ediciones puntuales: la global
representa la lectura completa que un replanner pretende modificar y no la
sustituye.

La validación de state es una función pura única. `readState` y restore rechazan
un estado v4 inválido, incluidos ciclos `BLOCKS`, con el código específico; el
batch valida sólo su draft final para poder expresar reparaciones completas sin
persistir estados intermedios. Los estados v3 históricos se validan al migrar:
un ciclo existente se reporta y no se reescribe silenciosamente como v4.

El CLI ya es JSON-only. No se agregará un flag redundante `--json`; se normalizan
las respuestas y errores de las operaciones nuevas y de las rutas que usará un
replanner, con códigos de error estables y una política de salida documentada.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| Mantener core actual y delegar CAS/batch al plugin | Menos cambios inmediatos | El plugin reconstruye estado incoherente, no puede reparar el DAG atómicamente y duplicaría invariantes críticas. |
| Añadir planner/scheduler/ownership/workers al core | Centraliza más comportamiento | Acopla Climier a harnesses concretos e impide una API de plugins mínima y estable. |
| **Foundation transaccional y API pública mínima** | El plugin decide libremente y usa garantías fuertes sin importar internals | Requiere una migración v4 y una refactorización coordinada de core, CLI y fixtures. |

## Alcance

- Dentro: C1–C9 del plan del usuario: simplificación de core, invariantes del
  DAG, revisión/CAS, batch atómico, lectura coherente, CLI automatizable,
  hardening de data, runtime dataDir, versionado API y suite de aceptación.
- Fuera: planner, replanner, scheduler, critical path, waves, ownership,
  execution contracts, workers, validators, mailbox, run/attempt/retry,
  adapters Pi/OpenCode/FX, worktrees, model routing, watch/event stream/daemon,
  artifacts administrados por Climier y un execution plugin de producto.

## Riesgos y preguntas resueltas

- **Migración de estado:** `revision` no puede ser opcional si controla CAS. Se
  introduce v4 y una migración pura v2→v3→v4; versiones futuras se rechazan.
- **Batch y policies:** un batch no ejecuta código arbitrario de plugin bajo el
  lock. Reutiliza providers built-in y la selección/autorización existente por
  operación dentro de una única transacción. Cada entrada se prepara y autoriza
  contra la vista actual del draft, pero el batch genera un solo commit y un
  único log `core.batch` con resúmenes redacted por operación.
- **Lecturas coherentes:** snapshot/state son lecturas lock-free de un único
  archivo serializado mediante rename atómico; no prometen congelar writers
  posteriores, sino devolver una revisión completa que el caller puede usar en
  CAS.
- **Plugin data:** el contrato es JSON estricto. `data.node.delete(id)` y
  `data.project.delete(key)` devuelven `{ removed: boolean }`; un valor no JSON
  falla `PLUGIN_DATA_INVALID` antes de log/write.
- **Runtime:** `dataDir` deriva de `dirname(stateFile(projectDir))/plugins/<id>`
  tras validar el mismo id del descriptor; el host crea sólo ese directorio con
  permisos privados cuando la plataforma lo permita. El plugin es dueño de su
  contenido; uninstall no lo purga ni el host lo migra.
- **Compatibilidad API:** plugins sin `climier.api` o que exijan una versión no
  soportada fallan antes de importar su entrypoint. El corte v3 no promete
  compatibilidad silenciosa con el antiguo `api.core.version: 2`.
- **Salida CLI:** los textos no son contrato. La clasificación se hace por
  `error.code`; `T-pf-c5-cli-agent-contract` fija y prueba los códigos de
  salida por clase y convierte los errores públicos relevantes al envelope
  estructurado.
- **Data pesada:** `api.data` sólo guarda JSON pequeño. El host documenta la
  intención; `api.runtime.dataDir` es el destino para SQLite, logs y artifacts.

## Ejecución y acceptance

El DAG materializado deja una task con aceptación verificable por corte; no se
implementa una lista monolítica. Los cortes son: C1 retiro de execution/resolve
(`T-pf-c1-*`), C2 v4/invariantes/CAS/edge.remove (`T-pf-c2-*`), C3 executor,
API y CLI batch (`T-pf-c3-*`), C4 snapshot/state (`T-pf-c4-*`), C6 data JSON,
C7 dataDir, C5 contrato CLI, C8 versionado y C9 integración final. Cada task
apunta a su ADR, paths exclusivos, no-go zone y comando de verificación.

La suite final prueba: snapshot coherente, aislamiento A/B, CAS de revisión
global, reparación y rollback batch, ciclo bloqueado por CLI/API/batch, flujo
shell `state → batch → state`, persistencia de data/runtime tras restart y
ausencia de imports `src/**` en el fixture.

## ADRs derivados

- [ ] ADR-018: retirar semántica de ejecución y el bypass `task.resolve` → `.adrs/018-plugin-foundation-core-simplification.md`
- [ ] ADR-019: estado v4, invariantes centralizadas, `edge.remove` y CAS global → `.adrs/019-plugin-foundation-dag-integrity.md`
- [ ] ADR-020: batch atómico de operaciones del core → `.adrs/020-plugin-foundation-atomic-batch.md`
- [ ] ADR-021: superficie pública coherente para CLI y plugins → `.adrs/021-plugin-foundation-public-api.md`
