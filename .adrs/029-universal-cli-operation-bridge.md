# ADR-029: bridge universal y routing declarativo de writes CLI

- Gate: `G-remote-architecture-refactor-adr-029` · Deriva de: `G-remote-architecture-refactor-rfc` · Estado: borrador
- Fecha: 2026-09-26

## Contexto

El RFC propone que las mutaciones built-in ordinarias atraviesen Application Operations tanto en local como en remoto. Hoy no todo el camino local proporciona al bridge el `source` que exige `executeOperation`; además, algunos adapters preservan decisiones de lifecycle, policy, compatibilidad y envelopes que no se pueden reemplazar por una llamada genérica sin caracterizar primero el contrato.

La propuesta completa y sus invariantes están en [RFC: consolidar arquitectura post remote-v1](../.decisions/G-remote-architecture-refactor-rfc.md), secciones A y B.

## Decisión

1. Establecer en `src/application/` un único composition root del backend local que construya registry, `mutate`, selección de policy, autorización y `source` completo; solo crear/injectar esas dependencias después de seleccionar backend local. Inyectar el mismo source local en `batch` y retirar su `createLocalSource` duplicado. `executeOperation`/`executeBatch` siguen siendo la única delegación de mutaciones ordinarias; el backend remoto conserva su delegación HTTP y no carga las dependencias kernel/policy del cliente local. No se introduce fallback local en modo remoto.
2. Mantener en los adapters CLI la responsabilidad de parsing argv, actor, normalización, defaults, pre-reads, localización del resultado y envelope público. El router interno, cuando se consolide, contendrá solo metadata CLI (selector target/pre-read, subkind, `if_revision`, input sin actor, result locator y override de policy definido en esta decisión); no será catálogo canónico, schema HTTP ni motor de dominio.
3. Migrar por slices serializadas con paths y tests disjuntos:
   - Foundation/source/boundary: `src/application/operations/` y `src/cli/dispatch.mjs`, `src/cli/commands/batch.mjs`; tests `application-operation-bridge`, `application-backend-client`, `cli-dispatch` y nuevo boundary CLI. Un solo owner mantiene los tres helpers compartidos `src/cli/commands/internal/{task-routing,domain-routing,resolvable-lifecycle-routing}.mjs` al consolidar el router; no se editan en paralelo con command migrations.
   - Lifecycle task/gate: `take`, `release`, `submit`, `accept`, `reject`, `resolve`, `reopen`, `cancel` y sus suites `v2-take*`, `task-lifecycle-*`, `plugin-policy-seam-lifecycle`, `cli-remote-resolvable-lifecycle-routing`. `take` debe conservar el contrato especial siguiente.
   - Creation/update multi-kind: `add-task`, `add-gate`, `add-knowledge`, `add-node`, `update` y `internal/create-node.mjs`; tests de create/update por kind, `v2-update`, `v2-execution-contract` y remote domain routing.
   - Domain writes restantes: `add-initiative`, `add-note`, `add-edge`, `remove-edge`, `deprecate-knowledge`; tests de initiative/note/edge/knowledge y remote domain routing. La edición de `internal/domain-routing.mjs` pertenece al owner que consolida router, antes de estas migraciones.
   - Batch final: `batch.mjs` usa el source único definido en foundation; no crea un segundo composition root.
4. **Takeover solo en el path CLI.** `take` necesita una extensión compatible de Application Operations/kernel que permita al adapter CLI derivar la policy action del plan preparado contra el snapshot fresco bajo el lock. La extensión es opt-in por request/host: el path CLI la usa, mientras `api.core.run` conserva exactamente su comportamiento actual (`task.take`) para no romper `test/plugin-policy-parity-cli-api.test.mjs`. Bajo esa extensión: `task.takeover` requiere `allow` explícito; sin policy, con `abstain` o `deny` no se reemplaza el claim y se conserva el error histórico (`ALREADY_CLAIMED` para sin-policy/abstain, `PolicyDenied`/`POLICY_DENIED` para deny); una toma idempotente del mismo actor no autoriza ni muta. La autorización ocurre dentro del pipeline bloqueado, antes de `apply`, con el plan derivado del snapshot fresco y sin un segundo ni nested `mutate`. Hoy `executeOperation`/`kernel.mutate` no consumen `plan.policyAction`; conectarlo sin violar el single-entry kernel es parte de esta seam y debe ir acompañado de pruebas de sin-policy, abstain, deny y same-actor idempotence.
5. Antes de migrar adapters que decoran providers o policy, modelar en seams tipados de operación las compatibilidades que pertenecen a una transacción: `update.legacy_patch` se aplica en el mismo `mutate`; `resolve` conserva default `resolution_mode` y resolve repetido; `reopen` conserva limpieza de campos terminales; `cancel`/`reopen` preservan policy target; `deprecate-knowledge` conserva su error/envelope y log fields. `executeOperation` permite un request action de auditoría distinto del operation ID con el mismo provider/policy, o una extensión explícita equivalente, para conservar labels observables (`take`, `update`, `resolve`, `reopen`, `cancel`, `deprecate-knowledge`). No hacer un segundo mutate ni normalizar una diferencia sin pruebas.
6. Mantener `init`, `restore`, `push` y `pull` fuera de “writes ordinarias”. Antes de cualquier migración, registrar por comando owner, paths, contrato, excepción/boundary y pruebas; restore continúa siendo local mientras no haya una decisión remota propia.
7. Añadir una prueba de boundary/matriz que inspeccione los adapters de mutación y demuestre que cada operación migrada alcanza el bridge en local, además de la cobertura de routing remoto. Un allowlist temporal de excepciones legacy debe ser explícito, versionado y decreciente.

## Consecuencias

- A favor: local/remoto comparten IDs y semántica de operaciones sin trasladar persistencia o policy a los adapters.
- A favor: los cambios se pueden verificar y revisar por familia, con trazabilidad de compatibilidad.
- En contra / deuda: el composition root y los seams de policy requieren modelar diferencias que hoy están distribuidas entre adapters.
- En contra / deuda: las excepciones de state/transfer siguen teniendo boundaries separados hasta una decisión específica.

## Plan de implementación

1. **Composition root local y contrato del source** — archivos: nuevo `src/application/local-operation-source.mjs` (nombre propuesto fijo para esta decisión), `src/cli/dispatch.mjs`, `src/application/backend-client.mjs`, `src/cli/commands/batch.mjs`, tests `application-operation-bridge`, `application-backend-client`, `cli-dispatch` y nuevo `test/cli-operation-bridge-boundary.test.mjs`. Crear source local solo tras elegir backend local; suministrarlo tanto al cliente local como a batch y retirar `batch.createLocalSource`. Afirmar que la rama remota no importa/carga kernel o policy.
2. **Router declarativo** — archivos compartidos `src/cli/commands/internal/{task-routing,domain-routing,resolvable-lifecycle-routing}.mjs` y sus tres suites de routing remoto. Un owner los consolida antes de las migraciones; prueba selectors, revision defaults, input actor-free y locator de resultado. No editar estos helpers en paralelo con command migrations.
3. **Compatibility seams y boundary de lifecycle** — archivos de application/kernel estrictamente necesarios para request audit action y policy action derivada del plan, más `src/cli/commands/{take,resolve,reopen,cancel}.mjs`; incluir tests `v2-take*`, `plugin-policy-seam-lifecycle`, `plugin-policy-parity-cli-api`, `task-lifecycle-*` y pruebas nuevas de source local. No iniciar el resto de lifecycle hasta resolver estos seams.
4. **Lifecycle restante** — adapters `src/cli/commands/{release,submit,accept,reject}.mjs`; suites lifecycle y routing. `src/cli/commands/internal/resolvable-lifecycle-routing.mjs` pertenece exclusivamente a la slice del router (paso 2) y no se toca aquí. Preservar envelopes, log/state y policy por tipo.
5. **Creation/update multi-kind** — `add-task`, `add-gate`, `add-knowledge`, `add-node`, `update`, `internal/create-node.mjs`; tests de create y `v2-update`/`v2-execution-contract`. Escribir un seam atómico para `legacy_patch` antes de migrar `update`.
6. **Domain writes restantes** — `add-initiative`, `add-note`, `add-edge`, `remove-edge`, `deprecate-knowledge`; suites de iniciativa/note/edge/knowledge y routing. `internal/domain-routing.mjs` debe pertenecer a la slice del router, no a una migración simultánea.
7. **Cierre** — correr matriz completa local/remota, remover allowlist de excepciones solo cuando esté vacía y actualizar el inventario `init`/`restore`/`push`/`pull`; no migrar esas cuatro operaciones en este ADR.

## Onboarding breve para crear tasks

- [x] Onboarding realizado — inspección de `dispatch`, backend client, bridge, adapters y helpers. Foundation primero; luego un único owner para los tres router helpers, después seams de policy/audit y lifecycle, migración multi-kind, domain writes y cierre. Los archivos `resolve.mjs` y `deprecate-knowledge.mjs` están incluidos; `init`/`restore`/`push`/`pull` quedan fuera. No ejecutar workers concurrentes contra adapters/helpers compartidos.
- [ ] No hace falta —

## Verificación

- Tests del composition root prueban que `executeOperation` local recibe registry, mutate, policy y autorización completos exactamente una vez; el mismo source es usado por batch y solo se construye si backend local fue seleccionado.
- Mantener el catálogo built-in canónico como fuente de los IDs; la prueba de boundary/matriz relaciona cada adapter CLI con el ID de catálogo y con su resultado, pero no agrega IDs ni schema remoto al router. El router es metadata de traducción argv/pre-read/resultado, no otra tabla de capacidades.
- Una matriz/boundary test cubre cada write migrada en local y demuestra el camino por bridge; tests de backend prueban el routing remoto equivalente y la ausencia de fallback.
- Tests conservan `task.takeover` con allow explícito requerido y casos sin policy/abstain/deny; same-actor idempotence; `NOT_READY`; defaults de resolve y resolve repetido; limpieza de campos en reopen/cancel; `legacy_patch` atómico; audit labels, envelopes, códigos de error, logs, revisions y state observables antes/después.
- No hay adapters migrados que importen provider, kernel o storage para ejecutar la mutación. Las excepciones state/transfer están listadas con owner/path/test.
- `node --test` sobre los tests de routing, lifecycle y operación afectados; `npm test`, `npm run test:concurrent` y `git diff --check` al cerrar el ADR. Oxlint sigue informativo y no bloquea.
