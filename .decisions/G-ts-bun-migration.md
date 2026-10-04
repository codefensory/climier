# RFC: TypeScript + Bun-native migration (v2, post-review)

- Gate: `G-ts-bun-migration` · Iniciativa: `ts-bun-migration` · Estado: en review (v2)
- Autor: orchestrator + asistente · Fecha: 2026-10-03
- v1: reviews `reviewer-producto`, `reviewer-arquitectura`, `reviewer-ejecucion` en el gate.

## Decisión rectora

**El resultado debe verse como si climier se hubiera construido con Bun desde el
inicio.** No hay camino Node, no hay shim de compatibilidad, no hay `dist`. Bun
es el runtime, el toolchain (install/test/run/pack) y el servidor. TypeScript es
nativo, sin build. La arquitectura queda **acíclica** y cada capa con una sola
dirección de dependencia.

## Problema (corregido tras review)

`climier` es ESM puro y sin dependencias, hoy publicado como fuentes `.mjs` con
`#!/usr/bin/env node` y `engines.node>=20`. Corre sin cambios bajo Bun 1.4
(medido: `bun test` = 1648 pass / 1 skip / 4 fail). No hay tipos, no hay
`tsconfig`, y el manejo de errores es ad-hoc: **71** `.code =` solo en
`src/storage`, ~15 factories locales (`clientError`, `transferError`,
`loginError`, `contractError`, …) y un espacio de códigos real de **52**, de los
cuales **33 no están declarados** en `V2_ERROR_CODES` (19). Detrás hay un ciclo
real `application ↔ plugins` que impide un grafo de tipos limpio.

## Propuesta

Cuatro fases, cada una green-to-green, sin big-bang:

- **Fase A — Toolchain Bun.** Bun es el runtime/toolchain. Fuentes siguen `.mjs`.
  `bun test` como runner. Shebangs, `engines`, CI, lockfile, packaging.
- **Fase B — Arquitectura acíclica.** Romper `application → plugins`; un solo
  productor de `OperationSource` y de registry. Todavía `.mjs`.
- **Fase C — Sintaxis.** `.mjs → .ts` con un codemod determinista y un inventario
  completo de referencias (no "~12 strings").
- **Fase D — Tipos.** Type-kernel en `contracts/`, codegen por reflexión, drift
  ratchet, project references, `strict` por boundary.

## Correcciones a v1 (evidencia del repo)

- **C3 / catálogo**: `scripts/check-retired-surfaces.mjs:9` **ya** importa
  `KNOWN_COMMANDS`; no hay copia. `KNOWN_COMMANDS.length === 39` (no 44).
  `help`/`version` no son módulos (se resuelven en `writeBuiltInResponse`).
  La lista remota real es `REMOTE_SUPPORTED_COMMANDS` (`dispatch.mjs:73`).
- **C1 / errores**: el universo es 52 códigos, no 19. Incluye `REMOTE_*`,
  `INVALID_PROVIDER_INPUT`, `CLIMIER_LEDGER_*`, `CLIMIER_CORRUPT_*`, más
  `CLI_ERROR_CODES` y `STORAGE_ERROR_CODES`.
- **C2 / `OperationSource`**: no coincide con ningún productor real.
  `local-operation-source.mjs` arma `loadApplicablePolicy`; 8 comandos arman
  `selectPolicy: async () => policy`; la rama `source.kernel.mutate` es dead code.
- **Ciclo**: `src/application/local-operation-source.mjs:6` → `../plugins/policy.mjs`
  y `src/plugins/core-adapter.mjs:6` / `core-registry.mjs:5` → `../application/operations/*`.
  `tsc -b` exige grafo acíclico: el ciclo se rompe en Fase B.
- **Rename**: los filtros/literales `.mjs` en `test/architecture/import-graph.mjs:209`,
  `scripts/check-retired-surfaces.mjs:25`, `test/contracts-layout.test.mjs` y
  `test/architecture/import-boundaries.test.mjs` **no son imports** → entran al inventario.

## Arquitectura objetivo (acíclica, una sola dirección)

```
contracts    (hoja: solo tipos; no importa runtime bajo src/)
storage      -> contracts
kernel       -> contracts, storage
providers    -> contracts, kernel
read-model   -> contracts, kernel, providers
application  -> contracts, kernel, providers, read-model, storage   (SIN plugins)
plugins      -> contracts, application, storage
server       -> contracts, application, plugins, storage
cli          -> todos
```

Regla dura: **`application` no importa `plugins`**. El wiring de policy se inyecta
desde la raíz de composición (`cli/`, `server/`), no se importa. Esto preserva
`tsc -b` por boundary y los boundaries ya testeados.

## Contratos a formalizar (resueltos)

### C1 — Error contract (`src/contracts/errors.ts`)

Universo declarado por dominio, unión total:

```ts
export type CoreErrorCode    = (typeof V2_ERROR_CODES)[keyof typeof V2_ERROR_CODES];
export type StorageErrorCode = "CLIMIER_LEDGER_*" | "CLIMIER_CORRUPT_*" | "ENOENT" | …;
export type RemoteErrorCode  = "REMOTE_*" | …;
export type PluginErrorCode  = "PLUGIN_*" | …;
export type CliErrorCode     = (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];
export type ErrorCode = CoreErrorCode | StorageErrorCode | RemoteErrorCode | PluginErrorCode | CliErrorCode;

export class ClimierError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
  toJSON(): ErrorEnvelope;
}
export function throwV2(code: ErrorCode, message: string, details?: ErrorDetails): never;
```

Regla: ningún `.code =` fuera de `contracts/errors.ts`; todo productor usa
`climierError(...)`. Los ~71 sitios de `storage/ledger/*` migran a
`StorageErrorCode`.

### C2 — OperationSource + provider generics (`src/contracts/operations.ts`)

Puerto puro; la implementación de policy se inyecta:

```ts
export interface OperationSource {
  registry: OperationRegistry;
  mutate: MutateFn;
  loadPolicy?(args: { projectDir: string }): Promise<Policy | null>;  // un solo nombre
  authorizeAction?: AuthorizeAction;
  pluginId?: string;
}
export interface Provider<I = unknown, P = unknown, R = unknown, E = unknown> {
  prepare(args: PrepareArgs<I>): Promise<P> | P;
  apply(args: ApplyArgs<I, P>): Promise<ApplyResult<R, E>> | ApplyResult<R, E>;
}
```

Resolución: colapsar los 8 `selectPolicy: async () => policy` y el
`loadApplicablePolicy` en **un** builder; mover el builder a la raíz de
composición para cortar `application → plugins`; `server/http.mjs` deja de
construir su propio registry.

### C3 — Command module + dispatch estático (`src/cli/commands/contracts.ts`)

```ts
export type Command = (typeof KNOWN_COMMANDS)[number];          // 39, derivado
export interface CommandModule { knownFlags?: readonly string[]; default(ctx: CommandContext): Promise<unknown> }
export const COMMANDS = { /* solo comandos con módulo */ } as const satisfies Partial<Record<Command, () => Promise<CommandModule>>>;
```

`help`/`version` quedan como `BuiltinVerb` fuera del mapa. Drift test: el conjunto
de claves de `COMMANDS` == comandos de `KNOWN_COMMANDS` con módulo.
`REMOTE_SUPPORTED_COMMANDS` se deriva de `COMMANDS`, no se duplica.

### C4 — Plugin public API (`src/plugins/contracts.ts`)

```ts
export interface PluginApi { version: 1; runtime; query; data; core }
export interface PluginModule { default: { commands: Record<string, PluginCommand>; policy?: PluginPolicy } }
```

## Maquinaria (corregida)

1. **Codegen sin side effects.** Reflexión solo sobre catálogos puros
   (`V2_ERROR_CODES`, `KNOWN_COMMANDS`, `PUBLIC_*_OPS`, `registry.ops`). Los
   `knownFlags` se extraen por **AST (ts-morph)** porque importar los ~37 módulos
   dispara `bootstrapBuiltins()` y construye providers top-level.
2. **Drift ratchet + baseline con dueño.** El baseline de `any`/`as any`/
   `@ts-expect-error` lo captura la task que agrega `typescript` + `tsconfig`
   (Fase D.0), **antes** de crear `type-budget.mjs`.
3. **Project references** siguiendo el DAG de arriba (acyclic tras Fase B).
4. **Green-to-green** por coexistencia `.ts`/`.mjs` bajo Bun.
5. **Codemod + inventario.** `grep -rn "\.mjs"` con dueño por archivo; los
   literales de `test/` van a una task con paths de `test/` exclusivos.

## Ownership de la rama paralela (Fase D)

| boundary | dirs | tsconfig | depende de |
|---|---|---|---|
| contracts | `src/contracts` | `tsconfig.contracts.json` | — |
| storage | `src/storage` | `tsconfig.storage.json` | contracts |
| kernel | `src/kernel` | `tsconfig.kernel.json` | contracts, storage |
| providers | `src/providers` | `tsconfig.providers.json` | contracts, kernel |
| read-model | `src/read-model` | `tsconfig.read-model.json` | contracts, kernel, providers |
| application | `src/application` | `tsconfig.application.json` | +storage |
| plugins | `src/plugins` | `tsconfig.plugins.json` | contracts, application, storage |
| server | `src/server` | `tsconfig.server.json` | contracts, application, plugins, storage |
| cli | `src/cli`, `bin` | `tsconfig.cli.json` | todos |

## DAG de ejecución

```
A  T-ts-toolchain  Bun runtime/toolchain (fuentes .mjs)      (serial, base)
   T-ts-harness    de-Node del arnés / runner / manifest     (dep: toolchain)
B  T-ts-cycle      romper application→plugins; 1 source/registry   (dep: A)
C  T-ts-sweep      codemod .mjs→.ts + inventario completo     (dep: B)
D0 T-ts-infra      typescript+ts-morph+tsconfig + baseline budget   (dep: C)
   T-ts-contracts  type-kernel (errors+domain+operations)     (dep: D0)
   T-ts-gen        gen-types + drift ratchet                  (dep: contracts)
   T-ts-types-<boundary>  strict por project refs             (paralelo, tabla arriba)
E  T-ts-strict     gate strict global + verificación adversarial
   T-ts-server     Bun.serve (resuelve REMOTE_* HTTP)
F  T-ts-version    inyección de versión en build time (binario)
   T-ts-binary     bun build --compile por plataforma + CI release
   T-ts-plugins-bin verificar loader de plugins en binario
```

Acceptance por task: **un comando copiable + salida esperada**. A partir de Fase A
el comando es `bun test`; el gate de tipos es `bunx tsc -b`. Verificación
adversarial: mutar un literal de error y confirmar que el drift test falla.

## Decisiones aprobadas (2026-10-03)

1. **Bun-only, sin Node.** Runtime, toolchain (install/test/run/package) y servidor.
   Se suelta `engines.node`; se adopta `engines.bun`. Runner de test = **`bun test`**
   (los tests conservan la API `node:test`, ejecutada nativamente por Bun; solo se
   reescriben el runner custom y el collector TAP).
2. **Distribución por binario** vía `bun build --compile` por plataforma. Ya no se
   publican fuentes `.mjs`/`.ts` como artefacto principal. Versión **2.0.0** (break
   de runtime limpio).
3. **`/ui` fuera de alcance por completo.** No se toca ningún archivo de `ui/` ni
   el comando `src/cli/commands/ui.mjs`; queda tal cual, excluido del DAG.
4. **Arquitectura acíclica**: se rompe `application ↔ plugins` extrayendo el wiring
   de policy a la raíz de composición; un solo productor de `OperationSource` y de
   registry.

### Riesgos específicos del binario (nuevos)

- **Lectura de versión**: `src/cli/dispatch.mjs` lee `package.json` con
  `readFileSync(new URL("../../package.json", import.meta.url))`. En un binario
  compilado esa ruta no existe → la versión debe **inyectarse en build time**.
- **Loader de plugins**: el host hace `import(fileUrl)` dinámico de `.mjs` externos.
  Debe verificarse que un binario compilado puede importar plugins externos del
  filesystem; si no, el plugin loader necesita un fallback documentado.
- **Comando `ui` en binario**: `src/cli/commands/ui.mjs` resuelve `UI_DIR` relativo a
  su propio archivo; en un binario compilado esa ruta no existe. Al estar `/ui` fuera
  de alcance, el comando debe devolver un error accionable en modo compilado (no se
  modifica el subproyecto).

## ADRs derivados (se completa al aprobar)

- [ ] ADR-NNN: Bun como runtime único y publicación de fuentes `.ts` → `.adrs/NNN-*.md`
- [ ] ADR-NNN: Arquitectura acíclica con `application` sin `plugins` → `.adrs/NNN-*.md`
- [ ] ADR-NNN: Type-kernel en `contracts/` + codegen por reflexión y drift ratchet → `.adrs/NNN-*.md`
- [ ] ADR-NNN: Contrato público de plugins v1 tipado → `.adrs/NNN-*.md`
