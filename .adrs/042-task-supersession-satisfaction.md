# ADR-042: satisfacción de tareas reemplazadas

- Gate: `G-v1-baseline-rfc` · Deriva de: `G-v1-baseline-rfc` · Estado: borrador
- Fecha: 2026-09-27

## Contexto

Una tarea cancelada que conserva una arista `BLOCKS` hacia una dependiente la deja bloqueada para siempre: la derivación solo considera satisfechas las tareas `done` y `archived`, no hay una operación de superficie que archive tareas y `reopen` no acepta una fuente cancelada. El corte v1 ya tiene este caso concreto: `T-v1-single-writer` fue cancelada como duplicada tras ser absorbida por `T-v1-schema-bootstrap`, pero su arista hacia `T-v1-lane-retiro` continúa activa. La derivación de gates ya resuelve el mismo problema siguiendo la cadena de reemplazo de un gate `superseded` mediante `SUPERSEDES`.

## Decisión

1. **Una tarea `canceled` con reemplazo satisfecho satisface sus dependientes.** En `isSatisfiedV2`, se sigue la arista `SUPERSEDES` entrante hasta la tarea reemplazante, con la misma selección determinista y la misma protección contra ciclos que usa la derivación de gates. La cadena puede tener varios saltos; basta que el nodo terminal esté satisfecho (`done` o `archived`).
2. **El cambio queda limitado a tareas canceladas.** Tareas `open`, `in_progress` o `submitted` siguen bloqueando, incluso si tienen reemplazo: representan trabajo pendiente y no una pieza retirada. Una tarea cancelada sin reemplazo conserva la política defensiva actual y bloquea. Los ciclos y los ids desconocidos permanecen insatisfechos y la recursión termina.
3. **Se reutiliza el contrato de grafo existente.** No se agrega un comando ni una forma de persistencia: se usa `SUPERSEDES`, como en los gates, y no se cambia la semántica de gates ni knowledge.
4. **Alternativa diferida: comando explícito de archivar/retirar tareas.** El esquema ya admite `archived` y la derivación ya lo considera satisfecho; agregar una operación de dominio y un comando podría permitir retirar de forma explícita cualquier tarea obsoleta sin modelar un reemplazo. Se rechaza por ahora porque amplía la superficie curada de v1 y el flujo de permisos/lifecycle para un caso que ya puede expresarse con `canceled` más `SUPERSEDES`. La contrapartida de esta decisión es que una cancelación sin reemplazo sigue bloqueando: esa política evita desbloquear trabajo por accidente y un futuro verbo de archive/retire sería la vía explícita si aparece la necesidad de retirar tareas sin sucesora.

## Consecuencias

- A favor: una tarea cancelada como duplicada deja de bloquear cuando su reemplazo ya está satisfecho, y la cadena puede evolucionar mediante más reemplazos.
- A favor: se preserva la cautela ante tareas pendientes, cancelaciones sin sucesor, ciclos y referencias desconocidas.
- En contra / deuda: no se puede retirar una tarea cancelada sin reemplazo sin crear una sucesora satisfecha; el comando archive/retire queda como alternativa posible, no como parte de este corte.

## Verificación

- Siete pruebas con snapshots literales cubren reemplazo `done` y `archived`, reemplazo abierto, ausencia de reemplazo, cadena de dos saltos, ciclo y comportamiento existente de gates/knowledge.
- Una prueba E2E en proyecto y `CLIMIER_HOME` temporales verifica `status` y `context` con reemplazo satisfecho y con reemplazo abierto.
- La confirmación sobre el grafo vivo es un paso del dueño posterior a la promoción del trunk integrado al plano de control. El binario de coordinación reside en un checkout separado y su proyección no adopta esta semántica antes de esa promoción; por eso esta comprobación no es evidencia de la task.
- La suite completa se ejecuta en un entorno limpio con las variables remotas de Climier sin definir.
