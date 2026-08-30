# Plan breve de ejecución: autoridad mínima del core (ADR-009)

Plan derivado de `.adrs/009-minimal-core-authority.md` (propuesto).
Convierte el contrato en el mínimo de cortes paralelos sin solapamiento:
solo paths afectados, no-go zones explícitas, orden mínimo, tests de
aceptación y riesgos. No implementa producto ni crea tasks hijas.

## 1. Punto de partida observado

Estado actual sobre `main` (HEAD `edc3eda`): el seam policy de
ADR-007/008 está cableado en todos los handlers; el core todavía
impone ownership por nombre en cuatro operaciones.

- `src/policy.mjs` ya provee `loadApplicablePolicy`,
  `authorizeAction` y `isPolicyError`. La función es pura; los
  handlers la llaman dentro de su `withLock`.
- `src/commands/take.mjs` clasifica `task.take`/`task.takeover`,
  conserva `previous_owner` y exige `--as`. No compara roles.
- `src/commands/resolve.mjs` (líneas 75–91) lanza `NOT_OWNER`
  cuando `claim.by` o `done_by` no coinciden con `as`.
- `src/commands/release.mjs` (líneas 61, 106–110) lanza `NOT_OWNER`
  cuando hay claim ajeno y la policy no hace allow.
- `src/commands/cancel.mjs` (líneas 69–76, 115) lanza `NOT_OWNER`
  para no-owners de un claim.
- `src/commands/reopen.mjs` (líneas 76, 103–111) lanza `NOT_OWNER`
  salvo que el actor sea `done_by` (sólo tasks; gates reabren
  cualquiera). Es el único punto donde `done_by` aún bloquea por
  defecto.
- `src/commands/restore.mjs` y `src/commands/init.mjs` ya pasaron
  por el seam state-ops de ADR-008 y no comparan roles; quedan
  intactos.
- `src/commands/context.mjs` calcula `allowed_actions` con
  `isOrchestrator` y emite `"release --as orchestrator"` para no
  owners. ADR-009 §"Contexto y documentación" lo prohíbe.
- `src/errors.mjs` define `NOT_OWNER` (línea 26). El código puede
  seguir existiendo para que un plugin lo emita como denial;
  ningún handler del core debe lanzarlo.
- `bin/climier.mjs` ya no menciona `orchestrator may take over` ni
  `--as orchestrator|recovery` (limpieza de ADR-008). No requiere
  más cambios de help.
- `docs/PLUGINS.md` describe el seam y los roles históricos. La
  sección de lifecycle debe actualizarse para reflejar autoridad
  mínima.
- Tests que asumen `NOT_OWNER` por defecto:
  `test/v2-lifecycle.test.mjs` (líneas 111, 331, 507, 662, 680),
  `test/v2-adversarial.test.mjs` (línea 504),
  `test/plugin-policy-seam-lifecycle.test.mjs` (líneas 291, 478,
  613, 745 — hoy verifican que `NOT_OWNER` se aplica ANTES del seam
  para no-owners; bajo ADR-009 esa precondición no existe para
  `resolve`/`release`/`reopen`/`cancel`).
- Tests que usan roles para bypass nominal:
  `test/v2-take-by-id.test.mjs`, `test/snapshots-restore.test.mjs`,
  `test/v2-add-task-initiative-lookup.test.mjs`,
  `test/v2-execution-contract.test.mjs`, `test/plugin-api.test.mjs`,
  `test/plugin-compat.test.mjs` (todos usan `as: "orchestrator"` o
  `as: "recovery"` como string opaco).

## 2. Paths afectados y no-go zones

Texto = estado actual; sufijo `(V3)` = cambio de este plan.

```text
src/commands/take.mjs                       clasificación take/takeover se mantiene;
                                             (V3) sin cambios de superficie.
src/commands/resolve.mjs                    (V3) elimina la rama NOT_OWNER (líneas
                                             75-91). El default core pasa a "abstain":
                                             cualquier actor con task en estado
                                             resoluble puede resolver.
src/commands/release.mjs                    (V3) elimina la rama NOT_OWNER (líneas
                                             106-110). Sin claim conserva su no-op
                                             idempotente; con claim, cualquier actor
                                             puede liberar.
src/commands/cancel.mjs                     (V3) elimina la rama NOT_OWNER (líneas
                                             69-76, 115). Cualquier actor puede
                                             cancelar una task/gate en estado
                                             cancelable.
src/commands/reopen.mjs                     (V3) elimina el check de done_by (líneas
                                             76, 103-111). Cualquier actor puede
                                             reabrir un nodo en estado terminal
                                             reabrible; el done_by/at/note se
                                             borra igual que antes.
src/commands/context.mjs                    (V3) allowed_actions elimina isOrchestrator
                                             y los strings "release --as orchestrator".
                                             allowed_actions describe invariantes de
                                             estado, no grants de ownership.
src/errors.mjs                              NOT_OWNER permanece en el catálogo para
                                             plugins; ningún handler core lo lanza.
src/policy.mjs                              sin cambios; authorizeAction ya cubre
                                             allow/deny/abstain y abstain = defaults
                                             core.
src/commands/restore.mjs                    sin cambios (ya pasó por state-ops).
src/commands/init.mjs                       sin cambios (ya pasó por state-ops).
bin/climier.mjs                             sin cambios (help ya limpio de roles).
docs/PLUGINS.md                             (V3) sección "Authority" reescrita: una
                                             invariancia core (no sobrescribir claims);
                                             policy opcional; --as opaco para auditoría.
test/v2-lifecycle.test.mjs                  (V3) migrar los cinco casos NOT_OWNER:
                                             release/reopen/cancel ahora pasan con
                                             actor no-owner; los asserts pasan a
                                             verificar que la mutación ocurre y deja
                                             nota.
test/v2-adversarial.test.mjs                (V3) caso "racy non-owner gets NOT_OWNER"
                                             ahora verifica que el actor no-owner
                                             GANA cuando la policy es nula/abstain
                                             y la invariancia de take sigue siendo
                                             del primer tomador.
test/v2-take-by-id.test.mjs                 (V3) caso "orchestrator takes over"
                                             migrado: el takeover es decisión de
                                             policy (allow/deny/abstain) o
                                             ALREADY_CLAIMED si ninguna policy
                                             aplicable lo permite; el agente del
                                             primer take puede ser cualquiera.
test/snapshots-restore.test.mjs             (V3) migrar as:"orchestrator"/"recovery"
                                             a un actor nominal (test-agent).
test/v2-add-task-initiative-lookup.test.mjs (V3) as:"orchestrator" → as:"test-agent"
                                             (uso nominal, no policy).
test/v2-execution-contract.test.mjs         (V3) as:"orchestrator" → as:"test-agent".
test/plugin-api.test.mjs                    (V3) caso "as: orchestrator with policy
                                             absent" → as:"test-agent" (la policy
                                             nula ya no necesita un actor especial
                                             para que el seam autorice).
test/plugin-compat.test.mjs                 (V3) idem: as:"orchestrator" nominal →
                                             test-agent.
test/plugin-policy-seam-lifecycle.test.mjs  (V3) reescribir los cuatro casos NOT_OWNER
                                             antes-del-seam (líneas 291, 478, 613,
                                             745): con policy nula, el actor no-owner
                                             EJECUTA la mutación; con policy allow,
                                             idem; con policy deny, sigue siendo
                                             POLICY_DENIED; con policy abstain, el
                                             default core ahora deja pasar al
                                             no-owner. Mantener cobertura de
                                             task.resolve con claim ajeno → muta.
                                             El caso "seam-resolve: NOT_OWNER is
                                             enforced BEFORE the seam" se reemplaza
                                             por "seam-resolve: no-owner resolves
                                             with policy absent/abstain/allow".
test/v2-docs.test.mjs                       NOT_OWNER puede seguir en catálogos de
                                             errores documentados (lo siguen usando
                                             plugins). Sin cambios.
test/v2-errors.test.mjs                     idem; sin cambios.
```

No-go zones explícitas:

- `src/policy.mjs`, `src/plugin-loader.mjs`, `src/plugin-descriptor.mjs`,
  `src/plugin-errors.mjs`, `src/plugin-core-registry.mjs`,
  `src/plugin-core-adapter.mjs`, `src/plugin-api.mjs`,
  `src/plugin-dispatch.mjs`, `src/plugin-runtime.mjs`,
  `src/plugin-query.mjs`, `src/plugin-data.mjs`, `src/log.mjs`,
  `src/storage/state.mjs`, `src/lock.mjs`, `src/agent.mjs`, `src/v2.mjs`,
  `src/v2-add-node.mjs`.
- `bin/climier.mjs` (HELP_TEXT ya está limpio).
- `src/commands/restore.mjs`, `src/commands/init.mjs`,
  `src/commands/add-task.mjs`, `src/commands/add-edge.mjs`,
  `src/commands/add-node.mjs`, `src/commands/add-gate.mjs`,
  `src/commands/add-knowledge.mjs`, `src/commands/update.mjs`,
  `src/commands/deprecate-knowledge.mjs`, `src/commands/add-note.mjs`,
  `src/commands/add-initiative.mjs` (estos handlers ya no imponen
  ownership por nombre tras los slices V2; no requieren cambios).
- Fixtures `test/fixtures/sample-plugin/`,
  `test/fixtures/core-plugin/`, `test/fixtures/plugins/policy-fixture/`.
- `.adrs/`, `.decisions/`.

## 3. Orden mínimo / batches

Tres cortes, secuenciales porque todos tocan tests del mismo grupo
(`v2-lifecycle`, `plugin-policy-seam-lifecycle`,
`v2-adversarial`) y migraciones de tests documentales dependen de
que el handler ya no lance `NOT_OWNER`. No hay paralelismo seguro
entre estos cortes: comparten assertions sobre el comportamiento
core de lifecycle.

```text
                T-plugin-policy-minimal-core-bootstrap
                              │
                              ▼
                T-plugin-policy-minimal-core-handlers
                              │
                              ▼
              T-plugin-policy-minimal-core-context-docs
                              │
                              ▼
              T-plugin-policy-minimal-core-tests-migration
```

| Task | Bloqueada por | Cambio principal |
|---|---|---|
| `T-plugin-policy-minimal-core-handlers` | este bootstrap | Elimina las cuatro ramas `NOT_OWNER`/`done_by` en `resolve`, `release`, `cancel`, `reopen`. Mantiene la clasificación `task.take`/`task.takeover` intacta. Cubre los cambios con un test focalizado por handler. |
| `T-plugin-policy-minimal-core-context-docs` | handlers | Reescribe `allowed_actions` en `context.mjs` y la sección de authority en `docs/PLUGINS.md`. Verifica con `v2-context-contract` que ya no aparecen strings `isOrchestrator`/`--as orchestrator`. |
| `T-plugin-policy-minimal-core-tests-migration` | context-docs | Migra los tests que asumían `NOT_OWNER` por defecto o `as:"orchestrator"`/`as:"recovery"` como bypass: `v2-lifecycle`, `v2-adversarial`, `plugin-policy-seam-lifecycle`, `v2-take-by-id`, `snapshots-restore`, `v2-add-task-initiative-lookup`, `v2-execution-contract`, `plugin-api`, `plugin-compat`. Las migraciones nominales (sin policy) pasan a `test-agent`; las pruebas de seam reescriben su expectativa para reflejar que la policy nula deja pasar al no-owner. |

Detalle por task:

### 3.1 `T-plugin-policy-minimal-core-handlers`

- **Paths propios**: `src/commands/resolve.mjs`,
  `src/commands/release.mjs`, `src/commands/cancel.mjs`,
  `src/commands/reopen.mjs`.
- **Cambio**: en cada handler, eliminar la rama que compara
  `claim.by`/`done_by` contra `as` y lanza `NOT_OWNER`. La rama
  `task.takeover` ya es opt-in del seam (ADR-008) y queda igual.
  En `reopen.mjs`, eliminar también el branch `node.subkind ===
  "task" ? ... : true` que diferenciaba tasks de gates: bajo
  ADR-009 ambos se tratan igual (cualquier actor reabre).
- **No-go zones**: el resto de `src/commands/`, `src/policy.mjs`,
  `bin/climier.mjs`, fixtures, docs, .adrs.
- **Verificación**: tests focalizados por handler (uno nuevo por
  handler, o ampliación de los ya existentes) más
  `npm test` global.

### 3.2 `T-plugin-policy-minimal-core-context-docs`

- **Paths propios**: `src/commands/context.mjs`, `docs/PLUGINS.md`,
  `test/v2-context-contract.test.mjs`.
- **Cambio**: en `context.mjs`, eliminar `isOrchestrator` y los
  strings `"release --as orchestrator"`. Las `allowed_actions`
  deben describir lo que el estado permite (ej. `"release"` cuando
  hay claim propio; `"cancel"` cuando el nodo es cancelable).
  En `docs/PLUGINS.md`, reescribir la sección "Authority" para
  distinguir: (1) invariancia core de no sobrescribir claims;
  (2) policy opcional que puede denegar o autorizar takeover;
  (3) `--as`/`CLIMIER_AGENT` como identidad opaca para auditoría.
- **No-go zones**: handlers (sellados por 3.1), `src/policy.mjs`,
  `bin/climier.mjs`, fixtures, otros docs.
- **Verificación**: `node --test test/v2-context-contract.test.mjs`
  más `npm test`.

### 3.3 `T-plugin-policy-minimal-core-tests-migration`

- **Paths propios**: `test/v2-lifecycle.test.mjs`,
  `test/v2-adversarial.test.mjs`,
  `test/plugin-policy-seam-lifecycle.test.mjs`,
  `test/v2-take-by-id.test.mjs`,
  `test/snapshots-restore.test.mjs`,
  `test/v2-add-task-initiative-lookup.test.mjs`,
  `test/v2-execution-contract.test.mjs`,
  `test/plugin-api.test.mjs`,
  `test/plugin-compat.test.mjs`.
- **Cambio**: las migraciones nominales (no policy) cambian
  `as:"orchestrator"`/`as:"recovery"` por `as:"test-agent"`. Las
  pruebas que validan el bypass histórico migran a dos formas:
  - Si la prueba asumía que el core bloqueaba al no-owner:
    invertir la expectativa (el no-owner ahora ejecuta la
    mutación); verificar el envelope `done_by` con el actor que
    realmente mutó.
  - Si la prueba asumía que un actor especial desbloqueaba la
    acción: convertirla en un caso con la fixture policy
    (`policy-fixture`) instalada y policy `allow`, para validar
    que una policy puede reemplazar el comportamiento.
- **No-go zones**: handlers, `context.mjs`, `src/`, `bin/`,
  fixtures, docs, .adrs.
- **Verificación**: `node --test` por archivo migrado más
  `npm test` y `npm run test:concurrent`.

## 4. Tests de aceptación

Comandos de verificación por task:

| Task | Comando |
|---|---|
| `T-plugin-policy-minimal-core-handlers` | `node --test test/v2-lifecycle.test.mjs`, `node --test test/v2-take.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-minimal-core-context-docs` | `node --test test/v2-context-contract.test.mjs`, `npm test`, `git diff --check` |
| `T-plugin-policy-minimal-core-tests-migration` | `node --test test/v2-lifecycle.test.mjs test/v2-adversarial.test.mjs test/v2-take-by-id.test.mjs test/snapshots-restore.test.mjs test/v2-add-task-initiative-lookup.test.mjs test/v2-execution-contract.test.mjs test/plugin-api.test.mjs test/plugin-compat.test.mjs test/plugin-policy-seam-lifecycle.test.mjs`, `npm test`, `npm run test:concurrent`, `git diff --check` |

Verificación global del ADR-009:

```bash
node --test test/v2-lifecycle.test.mjs \
         test/v2-adversarial.test.mjs \
         test/v2-context-contract.test.mjs \
         test/plugin-policy-seam-lifecycle.test.mjs \
         test/v2-take-by-id.test.mjs \
         test/snapshots-restore.test.mjs
npm test
npm run test:concurrent
grep -rn 'NOT_OWNER\|isOrchestrator' src/commands src/policy.mjs bin/ docs/PLUGINS.md
```

Casos que el grep final debe satisfacer:

- `NOT_OWNER` ya no aparece como `throw`/`new Error` en
  `src/commands/{resolve,release,cancel,reopen}.mjs`. Puede
  aparecer en `src/errors.mjs` (catálogo), en
  `test/plugin-policy-seam-lifecycle.test.mjs` (sólo cuando un
  plugin decide emitirlo como denial reason) y en tests
  documentales (`v2-docs`, `v2-errors`).
- `isOrchestrator` ya no aparece en `src/commands/context.mjs`
  ni en `bin/climier.mjs`.

Smoke manual del ADR (cubierto por los tests migrados):

1. Sin policy aplicable: `take` por agent-a, luego `release` por
   agent-b → claim liberado; `resolve` por agent-b → la task pasa
   a `done` con `done_by = agent-b`; `cancel` por agent-b →
   estado `canceled`; `reopen` por agent-b → estado `open`,
   `done_by/at/note` borrados.
2. Con policy deny sobre `task.resolve`: agent-b resuelve →
   `POLICY_DENIED` sin mutar.
3. Con policy allow sobre `task.takeover`: agent-a claimed,
   agent-b `take` → `previous_owner = agent-a`, claim del
   agent-b.
4. Sin policy sobre `task.takeover`: agent-b `take` con claim
   del agent-a → `ALREADY_CLAIMED`.
5. `task.take` mismo actor → idempotente (sin nueva mutación,
   `previous_owner` ausente).
6. Concurrencia: dos `take` simultáneos sobre una task libre →
   uno gana `task.take`, el otro recibe `ALREADY_CLAIMED` (la
   invariancia core sigue viva).

## 5. Riesgos principales

1. **Migraciones nominales que en realidad eran bypass.** Si una
   prueba con `as:"orchestrator"`/`as:"recovery"` ya dependía del
   bypass histórico, renombrarla a `as:"test-agent"` sin revisar
   la aserción puede ocultar regresiones (la acción que antes
   fallaba ahora pasa, y el test sigue verde sin verificar nada
   nuevo). Mitigado: cada migración debe quedar con un assert
   explícito de que la mutación ocurre con `done_by === actor` (o
   con `POLICY_DENIED` si el test exigía bloqueo y el bloqueo
   ahora viene de una policy). El cuerpo de cada test migrado se
   revisa uno por uno en el commit body.

2. **`reopen` de gate vs task.** El código actual trata los gates
   como reabribles por cualquier actor (`subkind === "task" ? ... : true`);
   las tasks exigen `done_by`. Eliminar la rama entera es seguro
   porque ADR-009 dice que cualquier actor reabre ambos; pero si
   un test histórico asumía el bloqueo en tasks, su migración
   invierte la expectativa y debe verificar el `reopen` real.
   Mitigado: tests focalizados por subkind en
   `T-plugin-policy-minimal-core-handlers` y revisión del commit
   body.

3. **Concurrencia: el segundo `take` ya no recibe `NOT_OWNER`.**
   `v2-adversarial.test.mjs` verifica hoy que el "racy non-owner"
   recibe `NOT_OWNER`. Con ADR-009, si la policy es nula, el
   segundo `take` sobre una task ya reclamada recibe
   `ALREADY_CLAIMED` (la invariancia core sigue en pie; sólo
   cambia qué tipo de denial). El test debe reescribirse para
   esperar `ALREADY_CLAIMED` cuando la policy es nula, y para
   esperar `previous_owner` reemplazado cuando hay policy allow.
   Mitigado: §3.3 y §4 smoke 3–5.

4. **Plugins existentes que aún esperan `NOT_OWNER` como denial
   reason.** Si una policy fixture emite `NOT_OWNER` como
   `decision: "deny" reason`, el envelope `POLICY_DENIED` lo
   propaga. Pero un plugin podría inspeccionar el `cause` del
   error y asumir que `NOT_OWNER` significa que el core bloqueó;
   ahora significa que el plugin bloqueó. Mitigado: nota en
   `docs/PLUGINS.md` §"Authority" indicando que `NOT_OWNER` como
   denial reason queda reservado a plugins; el core ya no lo
   emite. Una pasada de `grep` sobre `test/fixtures/` y
   `docs/PLUGINS.md` lo confirma.

5. **`allowed_actions` cambia el contrato público.** Consumidores
   que filtraban `"release --as orchestrator"` de
   `context.allowed_actions` deben actualizarse. ADR-009
   §"Compatibilidad y alcance" lo documenta como breaking change
   intencional. Mitigado: nota en release notes (fuera del scope
   de este bootstrap).

6. **`NOT_OWNER` queda en catálogos documentales.** El código
   puede seguir emitiendo el string por dos rutas: un plugin que
   lo use como denial reason, y tests que verifican el catálogo
   `V2_ERROR_CODES`. Esos usos siguen siendo válidos; los
   handlers del core no lo emiten. Mitigado: §4 grep final
   acota los archivos donde `NOT_OWNER` puede seguir apareciendo.

7. **Tests del seam V2 que documentan el orden policy→core.**
   `plugin-policy-seam-lifecycle.test.mjs` tiene un test
   nombrado "NOT_OWNER is enforced BEFORE the seam". Bajo
   ADR-009 ese orden ya no aplica para
   `resolve`/`release`/`reopen`/`cancel` con policy nula o
   abstinente. El test debe renombrarse y reescribirse para
   reflejar el nuevo orden (la policy decide primero; el core ya
   no añade una segunda capa de ownership). Mitigado: §3.3 y el
   smoke 6.
