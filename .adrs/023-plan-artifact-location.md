# ADR-023: Ubicación de los planes de ejecución

- Gate: `G-adr023-plan-artifact-location` · Deriva de: no aplica (decisión acotada del repositorio) · Estado: aprobado
- Fecha: 2026-09-24

## Contexto

El repositorio tenía dos ubicaciones para planes: `.plans/` y `docs/plans/`. Esa duplicación era innecesaria y causaba ambigüedad sobre dónde debían vivir los planes versionados. El documento `.plans/docs-site-web.md` contenía el plan de implementación del sitio de documentación y debía conservarse.

Los ADRs son los registros de decisiones arquitectónicas, no sustitutos de los planes detallados de ejecución. En este caso, la decisión sobre la organización de los planes debe registrarse aquí y el plan existente debe residir bajo `docs/plans/`.

## Decisión

1. El repositorio mantiene un solo directorio de planes versionados: `docs/plans/`.
2. Se elimina `.plans/`; los documentos que contenga y deban conservarse se mueven a `docs/plans/`.
3. Los ADRs en `.adrs/` registran contexto, decisión y consecuencias. Los planes detallados y ya completados o por ejecutar permanecen en `docs/plans/` y enlazan el ADR relevante cuando corresponda.
4. El sitio `web/` publica `docs/plans/` según su manifiesto; no publica directorios de planificación alternativos.

## Consecuencias

- A favor: hay una sola ubicación descubrible para los planes versionados, se conserva el plan del sitio y la decisión que originó el cambio queda registrada en un ADR aprobado.
- En contra / deuda: documentos o enlaces externos que aún apunten a `.plans/` deben actualizarse; no quedan consumidores internos de esa ruta.

## Plan de implementación

1. Se movió `.plans/docs-site-web.md` a `docs/plans/docs-site-web.md`.
2. Se eliminó el directorio `.plans/`.
3. Se reabrió y resolvió el gate de ADR-023 para que su elección y racional reflejen esta decisión.

## Onboarding breve para crear tasks

- [x] No hace falta — traslado documental y consolidación de directorio, sin cambios de producto.

## Verificación

- No existe `.plans/` en el árbol de trabajo.
- `docs/plans/docs-site-web.md` conserva el plan trasladado.
- El sitio de documentación incluye el plan por medio del inventario existente de `docs/plans/`.
- El gate `G-adr023-plan-artifact-location` está resuelto como aprobado para mantener un único directorio en `docs/plans/`; su elección y racional coinciden con esta decisión.
