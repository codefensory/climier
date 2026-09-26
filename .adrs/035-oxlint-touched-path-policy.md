# ADR-035: política Oxlint por paths tocados y cierre del baseline

- Gate: `G-rar-modular-organization-adr-035` · Deriva de: `G-rar-modular-organization-rfc` · Estado: aprobado
- Fecha: 2026-09-26

## Contexto

El RFC reemplaza shards indiscriminados por verificación ligada a responsabilidad real. El baseline de Oxlint 1.85.0, ejecutado con `npm run lint` (`oxlint src bin test`), es de 1.078 errores en 105 rutas con diagnósticos, de 306 archivos analizados, y cero advertencias. La UI independiente no forma parte de ese comando. Archivos grandes pueden empezar con deuda no relacionada con la slice, por lo que exigirles cero desde el primer cambio haría inviables tareas pequeñas; a la vez, permitir baseline sin medición ocultaría regresiones.

RFC fuente: `.decisions/G-rar-modular-organization-rfc.md`.

## Decisión

1. Para cada task que edite, mueva, cree o borre código/tests, la aceptación lista los paths fuente y destino exactos y ejecuta Oxlint 1.85.0 con la configuración del repo sobre esos paths.
2. Antes del cambio se guarda evidencia del baseline de todos los paths fuente. Después se lint-ean los paths fuente supervivientes y destinos. Para `git mv`/split, la task adjunta una tabla de migración que mapea cada finding de la fuente a un finding del destino donde quedó el mismo caso/código. Se compara el multiconjunto combinado `(code, severity)` de fuentes supervivientes + todos los destinos con el baseline fuente; mapping uno-a-uno solamente, sin desapariciones ni findings nuevos atribuibles al movimiento. El nombre de archivo puede cambiar solo según la tabla de mapping revisable. Código/casos realmente añadidos deben quedar en cero diagnostics. Tareas de separación estructural hacen no-regresión según esa comparación; no prometen arreglar toda la deuda existente.

Toda deuda heredada que quede en sources/destinos tocados se añade explícitamente al backlog de cleanup residual después de completarse el slice estructural. Cada cleanup tiene ownership exclusivo y acceptance cero para sus paths, incluso si esos paths fueron modificados antes por una task estructural. Una tabla/checklist de cobertura relaciona cada finding baseline con un owner de cleanup o con la excepción de deuda no incluida; no se puede declarar cubierto el global mientras haya findings sin owner.
3. Si el propósito explícito de una task es limpiar Oxlint de una unidad/path, la aceptación exige cero diagnósticos en esos paths (incluye deuda preexistente de esa unidad). Tareas de organización/refactor no asumen limpiado global incidental fuera de su slice.
4. Workers registran comando, versión, conteo inicial/final por regla/severidad/path y pruebas ejecutadas en la nota de submit. Captura reproducible desde la raíz: `./node_modules/.bin/oxlint --version` debe informar `1.85.0`, después `./node_modules/.bin/oxlint --format json -c ./.oxlintrc.json <paths>`; comparar diagnósticos por `(filename, code, severity)`. No se permite suppression nueva, desactivar regla, cambiar configuración ni usar autofix masivo para ocultar deuda. Autofix localizado puede usarse solo tras revisar diff y tests si no altera contrato.
5. ADR-033 y ADR-034 bloquean sus tasks de implementación hasta que ADR-035 se apruebe; cada task lista los gates ADR aplicables más ADR-035. Las tasks de limpieza también bloqueadas por ADR-035. La deuda de un path la posee una task a la vez.
6. Crear tasks de limpieza de diagnóstico con ownership exclusivo y acceptance cero por scope. Cubren findings por paths no modificados estructuralmente y todos los findings residuales heredados de los paths fuente/destino de las slices estructurales. La lista de residuos se calcula después de cada slice (destinos incluidos) y se añade con IDs de tasks cleanup y paths exactos. Dividir por directorios/path groups para permitir paralelismo. El plan final enumera tanto tasks estructurales como cleanup residual por cada finding original, antes del global.
7. El cierre global es un task distinto, dueño de `src bin test`, bloqueado por todas las tasks estructurales y todas las tasks de cleanup por scope (paths limpios a cero). Así ningún slice runnable puede reintroducir findings después del cierre. Ejecuta `npm run lint` con Oxlint 1.85.0 y exige cero errores y advertencias; reporta rutas analizadas, rutas con diagnósticos y total. `ui/` queda fuera; incluirla requiere otro cambio de configuración y baseline explícito.
8. La activación del lint en CI no forma parte de este ADR ni ocurre automáticamente al llegar a cero; requiere una decisión posterior.
9. Los findings contractuales baseline descubiertos durante modularización (por ejemplo recovery → commit → read de ledger) se crean y corrigen como tasks de comportamiento independientes, con test rojo primero, antes del split que dependa de esa semántica.

## Consecuencias

- A favor: cada worker demuestra el efecto de su cambio y reduce deuda relevante sin bloquear slices por findings ajenos; queda separado el control focal del cierre de baseline global.
- En contra / deuda: requiere evidencias baseline/final consistentes y una tarea de cierre explícita; las tasks estructurales pueden terminar con findings históricos no modificados, aunque el objetivo global siga siendo cero.

## Plan de implementación

1. Aprobar ADR-035 antes de crear tasks: toda task de implementación/cleanup se bloquea por ADR-035 y por el gate funcional aplicable.
2. Materializar slices estructurales con ownership paths exclusivo y acceptance de no-regresión; al aceptar cada una, actualizar el inventario de findings residuales y crear cleanup tasks cero por paths bajo ADR-035. Así se incluyen explícitamente residuos en módulos/suites que la slice dejó intactos.
3. El task global `src bin test` se crea después, bloqueado por todos los IDs estructurales y cleanup; acceptance `npm run lint` con Oxlint 1.85.0 devuelve exit 0, cero errores y cero advertencias.
4. Evaluar la activación de CI en una decisión separada una vez aceptado el cierre global.

## Onboarding breve para crear tasks

- [x] No hace falta otro onboarding — el comando exacto (`npm run lint`), versión, alcance, baseline observado, política por path y condición global de cierre están definidos; las tasks de implementación solo deben añadir sus paths/runner y evidencia.

## Verificación

- Para cada task, se comprueba `./node_modules/.bin/oxlint --version` = `1.85.0`; paths antes/después se ejecutan con `./node_modules/.bin/oxlint --format json -c ./.oxlintrc.json <paths>` y se compara por `(filename, code, severity)` con mapping revisable uno-a-uno cuando se mueven casos.
- Ninguna task añade hallazgos no explicados; los archivos/casos verdaderamente nuevos quedan limpios; tareas de limpieza focal terminan en cero para su scope declarado.
- Cada finding que quede tras un slice estructural tiene un cleanup owner ID/path antes de poder crearse el task global; el task global bloquea por todas las tasks estructurales y de cleanup, e informa cero globales.
- En cierre, `npm run lint` ejecuta Oxlint 1.85.0 en `src bin test` y devuelve cero diagnósticos.
- No se habilita CI sin decisión separada.
