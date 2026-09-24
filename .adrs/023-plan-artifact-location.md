# ADR-023: Ubicación y versionado de artefactos de planificación

- Gate: `G-adr023-plan-artifact-location` · Deriva de: no aplica (decisión acotada del repositorio) · Estado: aprobado
- Fecha: 2026-09-24

## Contexto

El repositorio usa dos ubicaciones con nombres parecidos para documentos de trabajo. `.plans/` aloja propuestas de planificación previas a la ejecución, por ejemplo `.plans/docs-site-web.md`. `docs/plans/` contiene planes de ejecución detallados que acompañan decisiones aceptadas y tareas activas. La diferencia no estaba declarada, y un plan en `.plans/` describía su propia ubicación como “ruido sin seguimiento” y dejaba abierta la pregunta de si debía versionarse.

El repositorio también conserva referencias a `docs/plans/` en ADRs, comentarios de código y documentación de agentes. El sitio `web/` publica intencionalmente `docs/plans/`, ADRs y decisiones, pero no debe exponer borradores internos de `.plans/` por accidente.

## Decisión

1. `.plans/` es un directorio versionado para documentos de planificación que exploran o estructuran trabajo antes de una decisión/ADR o antes de materializar tareas. Sus contenidos no son autoridad para cambiar arquitectura o contratos; esas decisiones se registran en `.adrs/`.
2. `docs/plans/` sigue siendo el directorio versionado para planes de ejecución duraderos derivados de decisiones aceptadas. Los documentos aquí pueden detallar secuenciación, ownership de archivos, batches y verificación; no sustituyen ni alteran el ADR que los gobierna.
3. Los planes pueden enlazarse entre sí, pero cada documento debe declarar su propósito y su relación con un RFC, ADR o iniciativa para evitar duplicar la fuente de verdad.
4. El sitio público `web/` no ingiere `.plans/`. Su inventario sigue limitado explícitamente a `docs/`, `docs/plans/`, `.adrs/`, `.decisions/` y los documentos raíz que ya estén permitidos por el manifiesto.
5. No se añade una regla de ignore para `.plans/`; los documentos existentes y futuros se incluyen en Git intencionalmente.

## Consecuencias

- A favor: se resuelve la ambigüedad de ubicación sin mover los planes existentes ni romper referencias estables; la planificación puede revisarse en Git; los artefactos públicos y los internos conservan límites explícitos.
- En contra / deuda: hay dos directorios de planes que requieren disciplina; cada nuevo documento debe escoger el directorio por propósito y declarar sus referencias.
- El contenido de `.plans/` podría ser incluido en un checkout o distribución del código, pero no se expone por el sitio documental salvo cambio explícito de su manifiesto.

## Plan de implementación

1. Documentar esta distinción como ADR aprobado — `.adrs/023-plan-artifact-location.md`.
2. Actualizar `.plans/docs-site-web.md` para sustituir su pregunta abierta por la decisión resuelta y enlazar ADR-023.
3. No mover ni borrar documentos de planes existentes; no cambiar el manifiesto público del sitio.

## Onboarding breve para crear tasks

- [x] No hace falta — este ADR registra una convención documental inmediata; no requiere implementación de producto ni tareas de seguimiento.

## Verificación

- `.plans/docs-site-web.md` describe `.plans/` como versionado y distingue su propósito del de `docs/plans/`.
- El manifiesto del sitio mantiene inventariados `docs/plans/` y excluye `.plans/`.
- El ADR figura en Git y su gate `G-adr023-plan-artifact-location` está resuelto como aprobado.
