# RFC: proyección y presentación read-only de datos de plugins

- Gate: `G-plugin-ui-rfc` · Iniciativa: `plugin-ui` · Estado: borrador
- Autor: orchestrator · Fecha: 2026-08-26
- Nota de proceso: solicitado sin ejecutar reviewers durante esta etapa.

## Problema

La UI de Climier es read-only y hoy conoce una forma fija del estado y de sus vistas. La plataforma propuesta en `G-plugin-platform-rfc` permitiría que plugins instalen comandos y guarden datos por proyecto o node, pero esos datos no deben quedar ocultos en JSON ni exigir que Climier añada un componente específico por integración.

Cargar código frontend arbitrario de cada paquete en la aplicación Solid crearía problemas de compatibilidad de build, rutas, dependencias, accesibilidad, estabilidad y confianza. Ejecutar un plugin durante `GET /api/snapshot` también rompería el límite read-only y haría que una vista pueda fallar o mutar al consultar datos.

Se necesita una forma limitada, útil y predecible de mostrar datos de plugin existentes: indicadores en nodes, secciones del detalle y métricas simples. La UI debe seguir sin ejecutar comandos ni mutar estado.

## Propuesta

### Principio

La UI no ejecuta código de plugins. Un plugin publica opcionalmente un descriptor estático JSON; el server lo lee, valida y proyecta junto con los datos persistidos. El frontend renderiza únicamente tipos de contribución que ya conoce.

El descriptor puede declararse desde `package.json`:

```json
{
  "climier": {
    "command": "validator",
    "entry": "./climier.mjs",
    "ui": "./climier.ui.json"
  }
}
```

Ejemplo de `climier.ui.json` para validator:

```json
{
  "node": {
    "badges": [
      {
        "path": "validation.phase",
        "equals": "running",
        "label": "Validating",
        "tone": "progress"
      },
      {
        "path": "validation.verdict",
        "equals": "pass",
        "label": "Validated",
        "tone": "ready"
      },
      {
        "path": "validation.verdict",
        "equals": "fail",
        "label": "Validation failed",
        "tone": "blocked"
      }
    ],
    "sections": [
      {
        "title": "Validation",
        "fields": [
          { "path": "validation.phase", "label": "Phase" },
          { "path": "validation.verdict", "label": "Verdict" },
          { "path": "validation.checks", "label": "Checks" }
        ]
      }
    ]
  },
  "overview": {
    "metrics": [
      {
        "label": "Awaiting validation",
        "path": "validation.phase",
        "equals": "running",
        "tone": "progress"
      }
    ]
  }
}
```

Las rutas se resuelven relativas a `node.plugins[packageName].data`; nunca permiten leer campos core, otros plugins, paths del filesystem o expresiones JavaScript. Los tonos son un catálogo finito que mapea a tokens existentes de UI, no clases CSS aportadas por el plugin.

### API del server

El server agrega proyecciones estáticas y datos ya persistidos a sus respuestas. No invoca handlers de plugin en requests. La forma exacta queda para ADR, pero conceptualmente:

```json
{
  "plugins": {
    "@climier/validator": {
      "available": true,
      "ui": { "...descriptor validado...": true }
    }
  }
}
```

En el detalle de node, la respuesta expone el bloque de datos de plugin ya almacenado y sus contribuciones aplicables. En el snapshot, el server calcula métricas declarativas sobre los datos de nodes. La proyección conserva los datos aun si un plugin no está instalado; en ese caso devuelve una señal `available: false` y la UI puede mostrar una sección neutra de "Plugin data unavailable" sin interpretar valores.

La API actual de snapshot, node y activity conserva sus campos core. Las contribuciones se agregan de forma namespaced para que un plugin defectuoso no invalide los datos centrales ni obligue al cliente a conocerlo.

### Renderizadores iniciales

El frontend solo implementa renderizadores genéricos para:

1. `badge`: indicador pequeño en summary o card de node, basado en una comparación `path` + `equals`.
2. `section`: sección read-only en NodeDetail con título y campos de texto/arrays seguros.
3. `metric`: contador en Overview de nodes cuyo dato coincide con una comparación declarada.

La posición exacta se restringe a slots fijos:

```text
node.summary.after-status
node-detail.after-summary
overview.metrics
```

No hay HTML de plugin, CSS de plugin, JSX/Solid de plugin, acciones mutantes, rutas nuevas ni llamadas HTTP iniciadas por el descriptor. Los valores se renderizan como texto; no se interpreta Markdown ni HTML.

### Compatibilidad con la UI actual

La UI mantiene sus principios actuales:

- read-only: ningún renderer ejecuta CLI ni endpoints mutantes;
- server como único lector de estado: el navegador no toca `tasks.json`;
- polling de snapshot y refresh de detail conservan sus cancelaciones y datos previos ante error;
- `StatusBadge`, tokens y accesibilidad existentes siguen siendo los primitives del host;
- errores de descriptor se aíslan como alerta de plugin y no hacen caer `snapshot` ni `NodeDetail`.

Antes de distribuir esta capacidad debe resolverse el empaquetado de `ui/`: el `package.json` raíz actual no incluye `ui/` en `files`, aunque `climier ui` lo necesita. El ADR debe decidir entre incluir el host UI completo, publicar un companion versionado o declarar una dependencia de distribución explícita. No se debe prometer plugins visuales instalables mientras `climier ui` no tenga un contrato de distribución verificable.

## Alternativas consideradas

| Opción | Pros | Contras |
|---|---|---|
| No mostrar datos de plugins | UI simple y estable | Los resultados de validator/agentes/integraciones quedan ocultos y el usuario vuelve a inspeccionar JSON o notas. |
| Importar bundles Solid/JS de plugins en la UI principal | Máxima libertad visual | Conflictos de versiones/build, seguridad, rutas, accesibilidad y fallos de plugin dentro de la aplicación anfitriona. |
| iframe o web component por plugin | Aislamiento mayor para UI rica | Comunicación, empaquetado y a11y complejos; desproporcionado para badges, checks y métricas. |
| **Descriptor JSON estático + renderizadores genéricos read-only** | Añade valor visible sin ejecutar código externo en el browser; testeable; mantiene el host estable | No habilita dashboards o interacciones completamente custom; el catálogo de renderizadores crece solo cuando hay evidencia de necesidad. |

## Alcance

- Dentro:
  - descriptor estático opcional por paquete de plugin;
  - validación de paths, tonos, slots, tipos y límites de descriptor;
  - proyección namespaced desde `ui/server/server.mjs`, sin invocar código de plugin durante requests;
  - renderizadores genéricos para badges, secciones y métricas;
  - estado visual de plugin instalado/no instalado/error de descriptor;
  - pruebas de servidor, componentes, accesibilidad y build;
  - decisión y verificación del empaquetado distribuible de `climier ui`.
- Fuera:
  - UI arbitraria de plugin, JS/JSX/Solid externo, CSS externo, import maps o dependencias frontend de terceros;
  - rutas de plugin, páginas custom, filtros custom o cambios a la navegación principal;
  - mutaciones desde la UI, ejecución de comandos, credenciales, webhooks o llamadas de red del plugin;
  - ejecución de handlers de plugin en el server UI;
  - iframe sandboxed o web components; pueden investigarse solo si el catálogo declarativo deja de cubrir una necesidad concreta.

## Riesgos y open questions

- Un descriptor puede crecer hasta ser un lenguaje de UI accidental → mantener tres renderizadores y slots fijos; todo renderer nuevo exige evidencia de un plugin real que no pueda representarse.
- Paths ambiguos o expresivos podrían filtrar datos core → rutas relativas al `data` del mismo plugin, con parser de segmentos simples y sin evaluación dinámica.
- Un plugin desinstalado puede dejar datos históricos → conservarlos y mostrar indisponibilidad; nunca eliminarlos desde la UI.
- Métricas sobre todos los nodes pueden aumentar el coste de polling → limitar comparaciones a igualdad simple, calcular en server y medir con el fixture de ~200 nodes ya existente.
- UI host no distribuida con el paquete raíz → resolver primero el modelo de packaging antes de anunciar soporte instalable.
- Un plugin no puede proveer un dashboard a medida → es una limitación intencional de la primera entrega; decidir iframe/sandbox solo cuando haya un caso que justifique la complejidad.

## ADRs derivados (se completa al aprobar)

- [ ] ADR-007: descriptor estático y proyección read-only de contribuciones de plugins → `.adrs/007-plugin-ui-descriptors.md`
- [ ] ADR-008: distribución y compatibilidad del host `climier ui` → `.adrs/008-ui-distribution.md`
