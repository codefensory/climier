# ADR-022: Metadatos del reclamo y frescura de claims

- Gate: `G-adr022-claim-meta` *(pendiente de registrar)* · Deriva de: *(RFC pendiente)* · Estado: implementado (2026-09-17, olas A–D)
- Fecha: 2026-09-17

## Contexto

Climier coordina trabajo entre actores que son, cada vez más seguido, procesos
de agente de larga duración. Al operar un DAG real (un producto con 18 nodos,
ciclos `take → submit → accept` completos y varias metas en paralelo) aparecen
cuatro hechos verificados:

1. **`--meta` ya existe** en `add-task`, `add-gate`, `add-knowledge`, `add-node`
   y `update` (obligatorio objeto JSON, con `--if-revision N`). Comprobado en un
   proyecto aislado: el nodo persiste el objeto tal cual.
2. **Pero `status` no expone `meta`.** Las filas traen
   `{id, kind, subkind, title, status, initiative, claimed_by}`. Un consumidor
   que necesite el meta debe hacer N llamadas a `show` o leer el archivo de
   estado interno, que no es una interfaz.
3. **`take` no acepta `--meta`** (solo `--as`; `--initiative`, `--domain` y
   `--tag` son legado ignorado). El dato del actor se conoce justo al reclamar,
   así que hoy hacen falta dos mutaciones y dos revisiones: `take` + `update --meta`.
4. **La frescura del reclamo se mide con `claim.at`**, que es la antigüedad del
   reclamo, no la de su actividad. Un actor que trabaja horas genera un
   **falso `stale-claim`**. Observado en producción:

   ```json
   { "kind": "stale-claim", "severity": "warning",
     "task_id": "T-m4-integration", "claimed_by": "scrap-many:integration",
     "age_ms": 321855733, "message": "... is stale (5364m old)" }
   ```

   sobre un reclamo legítimo de trabajo largo. La única forma de mantenerse
   fresco es `update`, que sí bumpea revisión y escribe log — es decir, el
   remedio contamina exactamente lo que el repo protege.

5. **El meta es un saco plano en el nodo.** Una tarea se reclama varias veces
   (reintento, resumen de sesión en otro equipo, otro modelo). Un saco plano
   pierde a qué intento pertenece cada dato.

El propio repo ya apunta en esta dirección: `docs/climier-ui.md` registra que
*"a futuro conviene agregar metadata estructurada a las notes"*, y
`src/plugins/data.mjs` ya obliga a los plugins a preservar `meta` como keyspace
propio.

**Alcance de este ADR: solo mecánica** (atomicidad, visibilidad, frescura). No
pide semántica: el core no debe conocer pids, sesiones, workspaces, modelos ni
transportes. Eso pertenece al actor, y `meta` es el lugar para escribirlo.

## Decision

### A. El meta pertenece al reclamo

1. `take <id> --meta '<json>'` (opcional, objeto JSON como en el resto del CLI)
   escribe `claim.meta` en la **misma** mutación que crea el reclamo: una
   revisión, un log.
2. Distinción explícita y documentada:
   - `node.meta` — qué es esta tarea. Persiste entre reclamos.
   - `claim.meta` — quién la está haciendo y con qué proceso. Vive con el
     reclamo y se archiva con el intento.
3. `submit` y `accept` archivan el `claim.meta` vigente junto al intento
   (`submitted_meta` / `accepted_meta`), del mismo modo que ya registran
   `submitted_by` / `accepted_by`.
4. `reject` y `reopen` limpian el meta del intento, coherente con lo que ya
   hacen con la submission y el reclamo.

### B. Visibilidad del meta

5. `status` agrega `meta` a las filas **solo cuando se pide**:
   `--meta-keys pid,space` (proyección elegida) o `--meta` (objeto completo).
   Sin flag, la forma actual no cambia, para no romper consumidores.
6. `status --mine` es el atajo de `--claimed-by <actor>` usando `--as` /
   `CLIMIER_AGENT`.
7. `--fields` / `--slim` en `show` y `status` acotan la salida. Es una necesidad
   medida: un `show` de un solo nodo real pesó **19,4 KB**, y el consumo de esa
   salida lo paga el contexto de un agente.

### C. Frescura del reclamo

8. `touch <id> --as <agent>`: solo el actor que ya tiene el reclamo; no cambia
   estado de dominio, solo actualiza `claim.heartbeat_at`.
9. `status --stale-ms` usa `claim.heartbeat_at ?? claim.at` como fuente de
   frescura. Sin latido, el comportamiento actual no cambia.
10. `release <id> --reason "..."` (opcional) para que liberar el reclamo de un
    actor muerto quede auditado en vez de ser un evento mudo.
11. `alerts` incorpora invariantes de estado: `in_progress` sin `claim`, y
    `done` sin `done_by`. Eso es lo que delata corrupción real, a diferencia de
    un reclamo simplemente viejo.

### D. Notas estructuradas

12. `add-note <id> "<texto>" --meta '<json>'` (opcional). Cubre lo que la UI ya
    tiene identificado como pendiente.

### Decisión abierta principal: cómo se escribe el latido sin romper invariantes

`touch` debe actualizar frescura con frecuencia, pero `AGENTS.md` regla 6 exige
que toda mutación entre por el kernel, bajo `withLock`, con revisión y log
atómicos. Tres caminos:

- **D1 (recomendado)** — `touch` es una mutación real, revisionada y logueada.
  No toca ningún invariante. Costo: N entradas de latido en el log (a 30 min de
  intervalo, ~6 por una tarea de 3 h).
- **D2** — el latido vive fuera del estado revisionado
  (`<state-dir>/heartbeats.json`, con su propio lock), como telemetría efímera;
  el read-model lo fusiona para calcular frescura. Log limpio, pero agrega un
  artefacto de storage y hay que decidir si entra en snapshots.
- **D3** — no implementar `touch` y que el actor refresque con `update`.
  **Descartado**: ensucia revisiones y log, que es el problema que motiva el ADR.

Se elige **D1** por no tocar invariantes; D2 queda como escape documentado si el
ruido del log se vuelve un problema real.

## Consecuencias

- **A favor**
  - Reclamar e identificar el intento pasan a ser un acto atómico: una revisión,
    un log, sin ventanas de inconsistencia.
  - El meta del intento sobrevive al reclamo y queda archivado junto a la
    submission, así que un DAG con reintentos es auditable sin prosa.
  - La detección de reclamos rancios (que ya existe en el núcleo) se vuelve
    confiable para trabajo largo, que es el caso de uso real de los agentes.
  - La vista externa de estado (`status`) deja de requerir leer archivos
    internos o hacer una llamada por nodo.
- **En contra / deuda**
  - `status` crece: mitigado porque la proyección es opt-in vía `--meta-keys`.
  - `claim.meta` es un campo aditivo y opcional, así que **no exige bump de
    `version`** (regla 5: un CLI viejo puede preservarlo e ignorarlo). Pero si un
    CLI viejo ejecuta `submit`, el meta del intento se pierde junto con el
    reclamo. Queda documentado, no silenciado.
  - D1 mete entradas de latido en el log; hay que vigilar el tamaño del log en
    tareas largas y, si molesta, migrar a D2.
  - `touch` no refresca el meta: son conceptos distintos y no conviene mezclarlos.

## Plan de implementacion

Cada pieza es candidata a task, con TDD (regla 2: primero el test que falla).

1. `take --meta` → `claim.meta` — archivos: `src/cli/commands/take.mjs`,
   `src/providers/task/`, `src/kernel/mutation/`, `test/v2-take.test.mjs`.
2. Archivado del intento en `submit`/`accept` y limpieza en `reject`/`reopen` —
   `src/providers/task/`, tests de lifecycle.
3. `--meta-keys` / `--meta` en `status` — `src/cli/commands/status.mjs`,
   `src/read-model/`, `src/cli/dispatch.mjs` (help), `test/status.test.mjs`.
4. `status --mine` — `src/cli/commands/status.mjs`, `src/cli/actor.mjs`.
5. `--fields` / `--slim` en `show` y `status` — `src/cli/commands/{show,status}.mjs`,
   `src/read-model/`.
6. `touch` (D1) — `src/cli/commands/touch.mjs`, `src/providers/task/`,
   `src/application/operations/builtins.mjs`, `src/cli/dispatch.mjs`, `test/`.
7. Frescura en `--stale-ms` — `src/read-model/`, `src/cli/commands/status.mjs`.
8. `release --reason` — `src/cli/commands/release.mjs`, `src/providers/task/`.
9. Invariantes de estado en `alerts` — `src/read-model/`.
10. `add-note --meta` — `src/cli/commands/add-note.mjs`, providers de notas.
11. Documentación del surface — `README.md`, `docs/reference.md` y la tabla de
    comandos de `AGENTS.md`.

Las piezas 1–5 no dependen de la decisión abierta y pueden entrar en paralelo.
La 6 queda bloqueada hasta cerrar D1 vs D2; las 7–9 dependen de la 6 sólo si se
elige un campo de latido nuevo.

## Onboarding breve para crear tasks

- [ ] Onboarding realizado — este ADR se corta en 4 olas: **(A)** meta del
      reclamo (piezas 1–2), **(B)** visibilidad (3–5), **(C)** frescura (6–9,
      bloqueada por D1/D2), **(D)** notas (10). Ambigüedades detectadas: si
      `claim.meta` debe fusionarse con `node.meta` en la lectura o mantenerse
      separados (recomendación: separados, y que el consumidor decida); y si
      `touch` debe aceptar `--meta` (recomendación: no, para no confundir
      frescura con datos).
- [ ] No hace falta — *no aplica: la decisión abierta D1/D2 necesita resolución
      antes de materializar la ola C.*

## Verificacion

- `climier take T-x --as a --meta '{"pid":1}'` → `climier show T-x` expone
  `claim.meta`, y la revisión avanzó **una sola vez**.
- `climier status --meta-keys pid` → la fila trae `meta.pid`. Sin el flag, la
  forma de la fila es idéntica a la actual (test de no-regresión del envelope).
- `climier submit T-x --note "..." --as a` → el nodo conserva el meta del
  intento archivado y `claim` queda en `null`.
- `climier touch T-x --as a` → `claim.heartbeat_at` avanza; con `--stale-ms`
  amplio no hay alerta, y con uno estrecho vuelve la alerta `stale-claim`.
- `climier release T-x --reason "proceso muerto"` → el log registra el motivo.
- Estado con `in_progress` sin `claim` → aparece en `alerts` como invariante.
- Suite: `npm test` en verde; `npm run test:concurrent` si se toca el kernel.
  Para las piezas 1–2 y 6, además un test de atomicidad: dos actores en
  paralelo, uno gana y el otro recibe `ALREADY_CLAIMED`.
