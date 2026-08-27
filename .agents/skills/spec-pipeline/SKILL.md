---
name: spec-pipeline
description: Flujo de specs de climier — RFC (gate research + .decisions/) → review con subagentes rfc-reviewer → ADR(s) (gate decision + .adrs/) → tasks (Technical Spec, --blocked-by el ADR) → workers. Usar cuando el usuario trae una idea, feature, migracion o cambio de arquitectura, o menciona RFC, ADR, spec o propuesta.
---

# spec-pipeline — de idea a ejecucion autonoma

```
idea → [RFC: gate research + .decisions/<G>.md]
     → [review: N rfc-reviewer en paralelo, notas en el gate]
     → [resolve G-rfc --choice aprobado]
     → [ADR(s): gate decision --blocked-by G-rfc + .adrs/NNN-slug.md]
     → [resolve G-adrN cuando este listo para ejecutarse]
     → [checkpoint de planificacion: sin bootstrap | bootstrap]
     → [tasks: --blocked-by G-adrN, body = puntero al ADR]
     → worker → validator → merge
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

## 4. Checkpoint de planificacion post-ADR

Antes de crear tasks de implementacion, el orquestador revisa el ADR y deja una decision explicita: **sin bootstrap** o **bootstrap**. Evalua paths y ownership, contratos compartidos, dependencias reales, batches paralelos, integracion, riesgos y estrategia de verificacion. No delega implementacion hasta terminar este checkpoint.

- **Sin bootstrap:** si el trabajo es acotado y el ADR ya permite tasks independientes con acceptance y verificacion claras, deja una nota breve en el gate ADR con el razonamiento y pasa al paso 5.
- **Bootstrap:** si hay varios modulos, seams inciertos, contratos compartidos, migraciones, concurrencia, paralelismo o integracion delicada, crea solo `T-<tema>-bootstrap`, bloqueada por el ADR. Su body apunta al ADR y su acceptance exige `docs/plans/<tema>-execution.md` con: mapa de codigo, boundaries/paths exclusivos, contratos y riesgos, estrategia de pruebas, batches/dependencias y propuestas de tasks con acceptance. El bootstrap no implementa producto ni materializa tasks hijas. Un validator debe hacer merge del plan; despues el orquestador lo revisa y crea el DAG de implementacion.

El bootstrap es condicional: no se crea por ritual para cambios locales evidentes.

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

- La spec vive en el ADR y, si existio bootstrap, tambien en `docs/plans/<tema>-execution.md`; el body es puntero + archivos + acceptance. El worker lee esos artefactos, no el proyecto a ciegas.
- Una task = un cambio principal + acceptance verificable. "Y ademas" → otra task.
- Materializa el DAG solo despues del checkpoint: contratos compartidos primero, implementaciones en paralelo, integracion al final. Edges `--blocked-by` solo reales.
- Dos workers no tocan el mismo modulo a la vez.

## Knowledge

Solo knowledge nodes y facts durables transversales (minimo un `--scope-*`). No ADRs (eso es gate), no obviedades.

## Templates

- `templates/rfc.md` — propuesta: problema, opciones, alcance, riesgos, ADRs derivados.
- `templates/adr.md` — decision: contexto, decision, consecuencias, plan por piezas (= candidatas a tasks), verificacion.
