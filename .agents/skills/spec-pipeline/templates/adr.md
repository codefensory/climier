# ADR-NNN: <decision>

- Gate: `<G-adrN>` · Deriva de: `<G-rfc>` · Estado: borrador | aprobado
- Fecha: <YYYY-MM-DD>

## Contexto

<lo minimo para entender esta decision sin leer el RFC entero; link al RFC para el curioso>

## Decision

<que se decidio, concreto y sin ambiguedad>

## Consecuencias

- A favor: <...>
- En contra / deuda: <...>

## Plan de implementacion

<piezas de trabajo en orden; cada pieza es candidata a task. Se documenta con evidencia, no con
intuicion: `colateral` son los tests/fixtures/scripts que la pieza toca u orfaniza
(`grep -rl "<simbolo>" test/ | wc -l`), no las lineas de `src/`. Una fila con `verde: no` no se
convierte en task: se re-corta (dejar de usar -> borrar lo muerto -> limpiar superficies) o se
corrige la pieza.>

| # | pieza | tipo | paths | colateral | tests | verde | verificar | turnos | depende |
|---|---|---|---|---|---|---|---|---|---|
| 1 | <pieza> | nuevo \| cambio \| delecion \| superficies | <paths> | <K tests> | primero \| mismo slice \| golden+borrar \| - | si \| no | <comando> | ~N | - |
| 2 | ... | | | | | | | | 1 |

## Onboarding y corte propuesto

Antes de materializar tasks, el orquestador registra una nota corta o marca que no hace falta:

- [ ] Onboarding realizado — <deltas, tabla de §Plan completada con colateral y verde por fila, y ambiguedades detectadas>.
- [ ] No hace falta — <por que el ADR ya permite crear una task clara>.

El onboarding no es un plan, no crea documentos ni tasks y no define pasos de implementacion.

## Verificacion

<como se prueba que el ADR quedo implementado: comandos, comportamiento observable>
