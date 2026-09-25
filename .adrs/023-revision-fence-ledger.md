# ADR-023: ledger monotónico y fence de revisiones

- Gate: `G-remote-revision-fence` · Deriva de: `G-remote-backend-rfc` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

El RFC requiere que push/pull, restore y el versionado nuevo no permitan reactivar CAS antiguos de `state.revision` o `nodes[id].revision`. Las rutas existentes de provider, batch y state operations asignan revisiones por separado; snapshots pueden contener revisiones históricas y un CLI antiguo puede reescribir state v4 aunque ignore una versión futura.

## Decisión

- Versionar el state actual v4 a v5 y añadir `fence_generation`; todo writer compatible verifica schema/generación antes de cualquier policy, precondición o CAS.
- Mantener ledger por proyecto fuera de `tasks.json` y snapshots, al lado del state file canónico (o en el directorio server-side resuelto por catálogo), usando el mismo `.lock`. Ledger ausente/ilegible/inconsistente una vez activado el fence falla cerrado; no se reconstruye desde state.
- Migrar una sola vez desde state pre-fence. Bajo lock calcula `H=max(state.revision,maxNodeRevision)`, `F=max(H,state.revision,maxNodeRevision)+1` y persiste `migration_pending` con H/F/generación/schema origen y SHA-256 exactos de source y destino calculado. El destino asigna state y todos los nodos a F. Auto-resume solo acepta fingerprint exacto source o destino; divergencia es regresión y requiere recovery explícito.
- El kernel mantiene la única adquisición de `.lock`. `withLock(projectDir, fn)` entrega a `fn` una capacidad opaca, ligada a ese proyecto y llamada; storage la valida y rechaza capacidades expiradas o de otro proyecto. Las APIs fenced `*UnderLock` no vuelven a tomar lock, y ninguna otra ruta puede saltarse la serialización.
- El commit usa `commitFencedStateUnderLock(lockContext, candidate)`: valida generation/schema del state actual antes de policy/precondiciones/CAS, exige candidato v5 con la misma generación local y revisiones monotónicas, prepara bytes exactos de destino, escribe stage file durable, registra en ledger `commit_pending` con high-water reservado + SHA-256 de source/destination + stage ID, y solo entonces renombra atómicamente state+log; finalmente consume pending y limpia stage. La reserva high-water es al menos `max(candidate.state.revision, maxNodeRevision(candidate))` y nunca baja.
- Recovery de commit pendiente bajo el lock reanuda solo si state raw coincide exactamente con fingerprint source o destination. Source intacto instala el stage durable; destination ya instalado consume pending; cualquier otro state/generación/hash falla cerrado. Persistido `commit_pending`, recovery completa exactamente ese candidato; no duplica log ni admite CAS durante recovery.
- No robar/expirar locks stale automáticamente. Falla con timeout; runbook requiere comprobar que el dueño murió y retirar lock manualmente antes de reanudar.
- Centralizar asignación de revisión para providers, `core.batch` preview/final y transfer: nuevo nodo ≥ state revision + 1; modificado = max(prev + 1, state + 1); state revision alcanza la máxima asignada. El marker/generación es local al ledger destino, nunca se copia desde snapshots/remotos.

## Consecuencias

- A favor: CAS global y por nodo monotónicos frente a borrado/recreación, transfer, restore, versiones antiguas y crashes.
- En contra / deuda: ledger y state no son un único archivo; la reserva puede dejar state temporalmente por detrás y exige recuperación; binarios locales viejos quedan fuera de soporte sobre proyectos fenced.
- Toda ruta de escritura, incluyendo helpers de storage y bootstrap, debe compartir la primitiva fenced; un writer que no pase por ella es defecto de integridad.

## Plan de implementación

1. Tests de contrato/migración/crash y ledger fenced de proyecto; archivos: `src/storage/state.mjs`, `src/storage/lock.mjs`, nuevo módulo de ledger, tests storage/kernel.
2. Helper común de revisiones para provider/batch y commit con fence; archivos: `src/kernel/mutation/revisions.mjs`, `diff.mjs`, `execute.mjs`, tests provider/batch.
3. Recovery compatible de restore/init force y errores de regresión; archivos: `src/kernel/state-operations.mjs`, `src/kernel/mutation/execute.mjs`, tests state-operation.
4. Integración de fence de destino con transfer atómico; archivos: kernel transfer y tests concurrentes (depende del contrato transfer ADR-025).

## Onboarding breve para crear tasks

- [x] No hace falta: el alcance es un único boundary transversal kernel/storage, dividido por fases secuenciales sin solapar ownership.

## Verificación

- Inyectar crash antes/después de ledger durable y rename state; restart reanuda solo fingerprint válido y state/log no quedan parcialmente publicados.
- Pre-CAS capturado global/node antes de migración, transferencia, restore y recreate permanece rechazado después.
- Downgrade legacy con `state.revision >= H` pero marker ausente bloquea operaciones hasta recovery compatible.
- `core.batch` observa las mismas revisiones que persiste; suite core de mutaciones/storage verde.
