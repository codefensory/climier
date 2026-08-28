# ADR-007: contrato y discovery de policy plugins

- Gate: `G-plugin-policy-contract-adr` · Iniciativa: `plugin-platform` · Estado: propuesto
- Deriva de: `G-plugin-policy-rfc`
- Fecha: 2026-08-28

## Contexto

Climier necesita permitir que plugins definan roles y reglas sin que el core conozca `orchestrator`, `recovery` ni ningún modelo operativo particular. Los plugins actuales tienen un descriptor con `id`, `command` y `entry`, y el entry exporta `default.commands`. El loader descubre plugins por namespace de comando; no existe una capacidad global de policy.

La policy debe aplicarse tanto a comandos CLI como a `api.core.run()`, sin depender de que el usuario invoque primero un comando del plugin. La instalación del plugin es global en `CLIMIER_HOME`, mientras que la configuración de cada proyecto vive en su `.climier.json`.

## Decisión

### Entry único

El descriptor no agrega una segunda ruta. Un entry puede exportar commands y policy:

```js
import policy from "./policy.mjs";

export default {
  commands: {
    roles: async (argv, api) => {},
  },
  policy: {
    applies: policy.applies,
    authorize: policy.authorize,
  },
};
```

`default.commands` sigue siendo obligatorio. `default.policy` es opcional. Cuando existe:

- `policy.authorize` es obligatorio y debe ser una función;
- `policy.applies` es opcional y debe ser función si está presente;
- no se permiten campos adicionales dentro de `policy`;
- un shape inválido del entry impide cargar el plugin completo, incluidos sus commands.

La validación pertenece a `importEntry()` en `src/plugin-descriptor.mjs`, después de importar el módulo y antes de devolverlo. `validateDescriptor()` continúa validando únicamente el descriptor de `package.json`. Un módulo no importable o con export inválido usa `PLUGIN_LOAD_FAILED`, con `details` de plugin, entry y campo.

### Discovery global

El host agrega `loadInstalledPolicyPlugins()` en `src/plugin-loader.mjs`. Este escanea los plugins instalados bajo el layout global existente, importa cada entry y selecciona los que exportan policy.

Para cada plugin:

1. si no exporta `policy`, no participa;
2. si no exporta `applies`, se considera aplicable a todos los proyectos;
3. si exporta `applies`, se invoca una vez por comando con el proyecto;
4. `applies` recibe una lectura raw de `.climier.json`; si el archivo no existe, recibe `{}`;
5. el resultado de `applies` no se cachea entre comandos;
6. si más de un plugin resulta aplicable al mismo proyecto, el host devuelve `POLICY_CONFLICT` con sus ids y namespaces;
7. la primera versión no combina policies.

El proyecto no guarda un puntero `policy_plugin` administrado por Climier. El plugin puede configurarse desde `.climier.json` usando exclusivamente:

```json
{
  "version": 1,
  "project_id": "...",
  "plugins": {
    "team-policy": {
      "mode": "strict"
    }
  }
}
```

El namespace obligatorio de cada plugin es `plugins[descriptor.id]`. El plugin solo lee su propio namespace. El core reserva el contenedor `plugins`, pero no valida ni interpreta su payload.

### Contrato de autorización

La policy recibe un diccionario serializable y read-only:

```js
{
  action,
  actor,
  target,
  snapshot,
  projectDir,
  projectConfig,
}
```

`actor` es exactamente el `actor_id` resuelto por `--as` o `CLIMIER_AGENT`. `pluginId` se conserva como metadata del host y no se concatena al actor.

La policy devuelve exactamente una de estas decisiones:

```js
{ decision: "allow" }
{ decision: "deny", reason: "..." }
{ decision: "abstain" }
```

- `allow`: permite continuar, sujeto a las invariantes core;
- `deny`: produce `POLICY_DENIED`;
- `abstain`: la policy no decide y se aplican los defaults core.

La policy no recibe `api`, `withLock` ni callbacks mutantes. No puede llamar `api.core.run()` ni modificar state/data durante `applies` o `authorize`. La escritura directa de archivos core por plugins queda prohibida por contrato; no se promete sandboxing.

### Errores

- `PLUGIN_LOAD_FAILED`: import o shape inválido del entry/policy;
- `POLICY_ERROR`: excepción o respuesta inválida en `applies`/`authorize`;
- `POLICY_DENIED`: decisión explícita `deny`;
- `POLICY_CONFLICT`: más de una policy aplicable.

Un error o una denegación nunca permite completar una mutación.

## Alternativas descartadas

- **Segundo entry para policy:** duplica instalación y discovery; contradice el contrato de entry único.
- **Policy solo como comando wrapper:** se puede evitar invocando directamente el CLI core o `api.core.run()`.
- **Policy configurada por Climier en el state:** mezcla configuración de plugin con el DAG y la ata al lifecycle de snapshots.
- **Roles en el descriptor:** obliga al core a conocer conceptos que deben pertenecer al plugin.

## Consecuencias

### Positivas

- Un plugin puede agregar roles y reglas sin modificar el schema semántico del DAG.
- La misma policy aplica a CLI y `api.core.run()`.
- La configuración puede ser específica por proyecto sin que Climier interprete su contenido.
- El contrato es compatible con plugins que solo exportan commands.

### Negativas

- Cada mutación puede depender de código externo instalado globalmente.
- Un entry con policy inválida no expone tampoco sus commands.
- Sin composición de policies, un proyecto solo puede tener una policy aplicable en la primera versión.
- `--as` sigue siendo una identidad falsificable; esto no es autenticación.

## Plan por piezas

1. Extender `importEntry()` para validar y devolver `policy` opcional.
2. Agregar `loadInstalledPolicyPlugins()` sin alterar el discovery por namespace de commands.
3. Agregar lectura raw de `.climier.json` y selección por `applies` sin cache entre comandos.
4. Agregar `src/policy.mjs` con `authorizeAction()` y los errores de contrato.
5. Crear el fixture `test/fixtures/plugins/policy-fixture/` y helpers de instalación/activación.
6. Probar entry único, shape inválido, `applies` ausente/presente, namespace propio, conflicto y errores de policy.

## Verificación

- `npm test`.
- Un plugin command-only sigue cargando igual.
- Un plugin con `default.policy.authorize` inválido falla con `PLUGIN_LOAD_FAILED` antes de ejecutar commands.
- Un plugin instalado globalmente no aplica a un proyecto si su `applies` devuelve false.
- La configuración se lee únicamente desde `plugins[descriptor.id]`.
- Dos policies aplicables producen `POLICY_CONFLICT` determinista.
- La policy recibe el actor sin transformación y no recibe APIs mutantes.
