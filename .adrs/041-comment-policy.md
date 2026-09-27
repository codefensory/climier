# ADR-041: política de comentarios y barrido con red de seguridad

- Gate: `G-v1-baseline-adr-041` · Deriva de: `G-v1-baseline-rfc` · Estado: borrador
- Fecha: 2026-09-27

## Contexto

Decisión del dueño: los comentarios innecesarios se eliminan. La medición del árbol, hecha al abrir este ADR: `src/` tiene **1.966 líneas de comentario sobre 21.460** (~9%) y `test/` **3.129 sobre 50.331** (~6%). Los archivos más cargados son `src/plugins/loader.mjs` (128), `src/plugins/errors.mjs` (109), `src/cli/commands/install.mjs` (94), `src/plugins/policy.mjs` (90), `src/providers/gate/lifecycle.mjs` (89) y `src/plugins/dispatch.mjs` (86). Buena parte son bloques de cabecera que narran qué hace el módulo y repiten formas de envelope o de schema que ya viven en los ADR, el README o `AGENTS.md`.

El corte mecánico obvio no es seguro. En `src/` hay **20 directivas funcionales** (`// oxlint-*`, `// eslint-*`) que cambian el comportamiento del lint si se borran, y los módulos del ledger (`src/storage/ledger/*`) documentan invariantes que el código no puede mostrar: ventanas de crash, orden de fsync y rename, la ley del high-water, los puntos donde el CAS debe evaluarse. Esos comentarios son la única especificación de durabilidad que tiene el producto, y el importador es la pieza que no puede fallar. Categorías medidas y candidatas a borrado en `src/`: 80 comentarios de provenance o era (`legacy`, `v2`, `previously`, `used to`), 31 espejos de schema o documentación, 10 banners decorativos, 8 bloques de código comentado, 0 `TODO/FIXME`.

## Decisión

1. **Un comentario existe solo para declarar una restricción que el código no puede mostrar.** Todo lo demás se borra. El criterio no es "pocos comentarios" sino "ningún comentario que repita lo que el código o la documentación ya dicen".
2. **Lista de borrado:** narración de lo que hace la línea siguiente; provenance (de dónde vino el código, qué versión anterior, qué compatibilidad arrastra); referencias a tasks o ADR usadas como justificación; bloques de código comentado; banners decorativos de sección; espejos de documentación (formas de envelope, de schema, listas de comandos o de campos que ya viven en los ADR, el README o `AGENTS.md`).
3. **Lista protegida, que no se borra nunca:** directivas funcionales (`oxlint`/`eslint`, shebang, pragmas), hoy 20 en `src/`; invariantes de durabilidad, orden de escritura, CAS, high-water y ventanas de crash; contratos de error cuando la forma exacta de `code` y `details` **es** la API; y en tests, el nombre del `test()` como spec (ADR-034) más los comentarios que declaran el contrato que el test fija.
4. **Red de seguridad verificable.** Manifiesto versionado de líneas de comentario por archivo —excluyendo la lista protegida— con un checker que falla si un archivo supera su baseline y ante los patrones prohibidos de §Decisión 2. El baseline **solo baja**: se actualiza cuando un barrido reduce el número, nunca para habilitar crecimiento.
5. **Política de touched-path.** Toda task que toque un archivo deja sus comentarios conformes, para que el barrido no se vuelva a ensuciar. Aplica desde este ADR en adelante; el barrido de §Decisión 6 es el backstop de lo que ya estaba.
6. **El barrido es una task de cierre, con owner único para `src/` y `bin/`**, sobre el árbol ya estabilizado y antes del release candidate. Los tests entran en la misma task con criterio más laxo: se borra la narración y se conserva lo que declara contrato.
7. **`AGENTS.md` incorpora la regla y la lista protegida** en sus convenciones de código, y la task de barrido es su dueña.
8. **Lo que no cambia.** No se agrega una regla de lint que cuente comentarios: el criterio no es mecánico. El checker verifica **no regresión y patrones prohibidos**, no calidad. Un archivo puede tener 60 comentarios legítimos de durabilidad y pasar, y otro con 5 de provenance no pasar.

## Consecuencias

- A favor: el código deja de duplicar documentación que envejece sola —hoy `src/` repite formas que el README y `docs/reference.md` ya dicen dos versiones atrás— y el árbol baja a un orden de 300 a 600 líneas de comentario legítimo.
- A favor: el manifiesto convierte "no quiero comentarios" en una propiedad verificable del árbol y no en una preferencia de review.
- En contra / deuda: el criterio requiere juicio humano y el checker no lo puede verificar; el riesgo real es borrar una restricción por parecer narración. La mitigación es la lista protegida de §Decisión 3 y la revisión por archivo de los módulos del ledger, que son los únicos donde el borrado es peligroso.
- En contra / deuda: hacer el barrido antes de las tasks estructurales lo ensucia de nuevo, y por eso va al final de la cadena, justo antes del release candidate.

## Plan de implementación

1. **Manifiesto y checker** — archivos: el manifiesto versionado, el generador y el verificador. TDD: el checker falla con un patrón prohibido sembrado y con un archivo por encima de su baseline, y pasa con los dos corregidos.
2. **Barrido de `src/` y `bin/`** — owner único. Aplicar §Decisión 1 y §Decisión 2, respetar §Decisión 3, y dejar el resultado del checker en la nota de cierre. Los módulos del ledger se revisan archivo por archivo, no en bloque.
3. **Criterio de tests en la misma task** — borrar narración, conservar contrato y nombres de `test()`.
4. **`AGENTS.md`** — la regla y la lista protegida en las convenciones de código.
5. **Enganche del checker** en `npm run` y en `.github/workflows/ci.yml`, conviviendo con la verificación de superficies retiradas de ADR-040.

## Verificación

- El checker pasa sobre el árbol barrido, y falla si se le siembra una fila prohibida o si un archivo crece por encima de su baseline.
- `grep` de los patrones de provenance y era en comentarios de `src/` no devuelve resultados (los 80 medidos), y no queda ningún bloque de código comentado ni banner decorativo.
- Las 20 directivas funcionales siguen presentes: `grep -rn "^\s*//\s*\(oxlint\|eslint\)" src/ | wc -l` sigue dando 20.
- Los invariantes del ledger siguen escritos: `src/storage/ledger/*` conserva sus comentarios de durabilidad, orden de fsync/rename y high-water.
- `npm test` y `npm run lint` verdes, y el manifiesto de comentarios versionado en el repo.
- `AGENTS.md` documenta la regla y la lista protegida.
