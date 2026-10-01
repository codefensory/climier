---
name: spec-pipeline
description: Flujo de specs de climier — RFC (gate research + .decisions/) → review con subagentes rfc-reviewer → ADR(s) (gate decision + .adrs/) → tasks (Technical Spec, --blocked-by el ADR) → ejecución con climierflow. Usar cuando el usuario trae una idea, feature, migración o cambio de arquitectura, o menciona RFC, ADR, spec o propuesta.
---

# spec-pipeline — de idea a ejecucion autonoma

```
idea → [RFC: gate research + .decisions/<G>.md]
     → [review: N rfc-reviewer en paralelo, notas en el gate]
     → [resolve G-rfc --choice aprobado]
     → [ADR(s): gate decision --blocked-by G-rfc + .adrs/NNN-slug.md]
     → [resolve G-adrN cuando este listo para ejecutarse]
     → [onboarding breve opcional para mejorar tasks]
     → [tasks: --blocked-by G-adrN, body = puntero al ADR]
     → `climierflow run <task-id>` → resultado terminal
```

Regla madre: el contenido largo vive en docs commiteados; climier guarda punteros, estado y trazabilidad. Nada de specs largas en bodies ni en prompts.

## 1. RFC

```bash
climier add-gate --initiative <init> --purpose research \
  --title "RFC: <tema>" \
  --body "Propuesta en .decisions/<id>.md. Reviewers comentan con add-note; bloqueos se resuelven antes de aprobar." \
  --as orchestrator
```

El id se puede fijar como primer arg posicional (ej. `G-auth`). Escribi `.decisions/<id>.md` con `templates/rfc.md` (en este skill). Investigar primero: repo, docs, web si aplica. El RFC compara opciones y recomienda una.

Cuando partir en varios ADRs (paso 3): subsistemas distintos, fases independientes o decisiones desacopladas.

## 2. Review

Lanza un `rfc-reviewer` (`.pi/agents/rfc-reviewer.md`) por lente, en paralelo (background). Minimo: arquitectura + ejecucion. Producto si toca UX/negocio.

Prompt: `Revisa <gate-id> con lente <lente>. El doc esta en el body del gate. Deja notas, no edites.`

Convencion de notas: cada lente (`rfc-reviewer`) deja exactamente **una nota consolidada** con secciones Bloqueos/Preguntas/Sugerencias, o `LGTM`. Multiples notas sueltas de la misma lente rompen la convencion.

Consolidacion: `climier show <G>` → agrupa notas por tema → resuelve `[bloqueo]` con el usuario → edita el doc → nota de cierre por bloqueo resuelto. Aprobar solo con OK del usuario:

```bash
climier resolve <G> --choice aprobado --rationale "<por que; bloqueos resueltos>" --as orchestrator
```

## 3. ADR

Uno por decision tecnica cohesiva. Cada ADR se basta solo: quien lee un ADR no necesita los otros.

```bash
climier add-gate <G-adrN> --initiative <init> --purpose decision \
  --title "ADR-NNN: <decision>" \
  --body "Decision en .adrs/NNN-<slug>.md. Deriva de <G-rfc>." \
  --blocked-by <G-rfc> --as orchestrator
```

Doc con `templates/adr.md`, numeracion secuencial en `.adrs/` (mirar el ultimo NNN y seguir). Aprobar cuando este listo para ejecutarse:

```bash
climier resolve <G-adrN> --choice aprobado --rationale "<resumen de la decision>" --as orchestrator
```

Si un ADR reemplaza a otro: `add-gate ... --supersedes <viejo>` (rewire automatico de dependencias). ADR riesgoso → tambien pasa por rfc-reviewer antes de resolverse.

## 4. Onboarding breve para crear tasks

Antes de crear tasks de implementacion, el orquestador puede hacer una pasada corta sobre el ADR y el codigo minimo relevante. El objetivo es entender el cambio y detectar como expresarlo mejor en tasks ejecutables.

El onboarding entrega solo una nota breve con:

- alcance entendido y paths probablemente afectados;
- sugerencia simple para separar o acotar tasks, si hace falta;
- ambiguedades, riesgos o criterios de acceptance que convenga aclarar.

No es un plan ni una secuencia de pasos. No crea una task de onboarding, no escribe `docs/plans/`, no arma batches, no crea tasks hijas y no implementa producto. Si el ADR ya alcanza para una task clara, se omite.

Debe terminar rapido. Si aparece una decision real o falta contexto, se informa al usuario o se abre una gate; no se inventa una solucion. Luego el orquestador crea y cura las tasks directamente.

## 5. Tasks (Technical Spec)

```bash
climier add-task --initiative <init> \
  --title "<cambio concreto>" \
  --body "Spec: .adrs/NNN-<slug>.md §<seccion>.
Archivos: <paths a tocar>.
No-go: <lo que no debe tocar>.
Verificar: <comando>." \
  --acceptance "<verificable>" \
  --blocked-by <G-adrN> --as orchestrator
```

- La spec vive en el ADR; el body de la task es puntero + archivos + acceptance. `climierflow` recibe ese contrato y ejecuta la task con el contexto del DAG.
- Antes de delegar, traza cada requisito verificable de las secciones del ADR cubiertas por una task hasta una task owner y un check de acceptance. Ningún punto de `Verificación` queda huérfano; controles operativos como rate limits también necesitan cobertura explícita.
- Para migraciones de contratos públicos, busca referencias existentes a rutas, headers, env vars, comandos y formatos retirados, incluyendo tests/fixtures y scripts de smoke registrados. Asigna su migración a un scope/acceptance o deja explícito por qué no cambian; un E2E nuevo no sustituye esa cobertura.
- Una task = un cambio principal + acceptance verificable. "Y ademas" → otra task.
- Las dependencias del DAG deben ser reales y salir del alcance decidido, no de un plan generado por el onboarding.
- Las ejecuciones deben respetar el scope de paths y las dependencias del DAG; no se solapan cambios incompatibles.

## Knowledge

Solo knowledge nodes y facts durables transversales (minimo un `--scope-*`). No ADRs (eso es gate), no obviedades.

## Templates

- `templates/rfc.md` — propuesta: problema, opciones, alcance, riesgos, ADRs derivados.
- `templates/adr.md` — decision: contexto, decision, consecuencias, plan por piezas (= candidatas a tasks), verificacion.
