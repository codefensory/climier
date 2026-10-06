# ADR-053: Arquitectura de tokens de dos temas, paleta dark y elevaciones

- Gate: `G-adr-dark-tokens` · Deriva de: `G-darkmode-rfc` · Estado: aprobado
- Fecha: 2026-10-06

## Contexto

`ui/src/styles/tokens.css` declara 30 tokens `--color-*` con valores claros dentro de `@theme`
(Tailwind v4.3.3). Las utilidades compilan a `var(--color-*)` y los tokens quedan como custom
properties, de modo que el mismo nombre sirve para `text-ink`, `bg-surface` y para `var()` desde
TS/SVG. El repo prohibe alias con `var()` y exige "un token por valor". `tint()` usa
`color-mix(in srgb, C N%, transparent)`, que sigue funcionando con cualquier valor de token.

Dos hechos verificados contra el compilador real de Tailwind 4.3.3:

1. `@theme` emite en `@layer theme { :root, :host { … } }` y **tree-shakea** los tokens sin
   consumidor. Un override **sin capa** de la misma custom property gana por cascada de capas.
2. Las utilidades `shadow-*` **inlinean** el valor (`--tw-shadow: 0 8px 24px var(--tw-shadow-color,#0000001a)`);
   overridear un `--shadow-*` en dark no cambia nada. En cambio `shadow-[var(--elevation-x)]`
   compila a `--tw-shadow:var(--elevation-x)` y resuelve por tema.

Ver RFC `.decisions/G-darkmode-rfc.md` §Propuesta 1–2 y §Alternativas B/C.

## Decision

1. **Una sola declaracion de nombres, dos juegos de valores.**
   - `@theme static { … }` conserva los 30 tokens claros (mismos hex que hoy) y agrega 5 tokens de
     color nuevos: `--color-overlay`, `--color-hover`, `--color-on-strong`, `--color-tone-red-bg`,
     `--color-tone-red-ink` (35 `--color-*` en total). `static` garantiza la emision de todo token,
     incluso los que solo se consumen via `var()` desde TS/SVG.
   - Un bloque **sin capa** `[data-theme="dark"] { … }` re-declara los 35 `--color-*` con la paleta
     dark de abajo. No hay una segunda capa de alias ni `@theme inline`.
   - Los componentes no llevan `dark:`: siguen usando los mismos nombres semanticos.
2. **`color-scheme` por tema** para controles nativos, scrollbars y `input`:
   `:root { color-scheme: light; }` y `[data-theme="dark"] { color-scheme: dark; }`.
3. **Elevaciones themeables.** Cuatro variables `--elevation-control`, `--elevation-edge`,
   `--elevation-overlay`, `--elevation-panel` definidas en `:root` y re-declaradas en
   `[data-theme="dark"]`; se consumen como `shadow-[var(--elevation-*)]`. Cada receta conserva en
   claro su literal exacto (una receta por literal distinto), para no alterar el tema claro.
4. **Paleta dark** (valores exactos):

| token | claro | dark |
|---|---|---|
| `ink` | `#111111` | `#f2f2f2` |
| `ink-soft` | `#333333` | `#d6d6d6` |
| `muted` | `#737373` | `#a0a0a0` |
| `faint` | `#8a8a8a` | `#909090` |
| `ghost` | `#d4d4d4` | `#4d4d4d` |
| `surface` | `#ffffff` | `#18181b` |
| `raised` | `#fafafa` | `#1e1e22` |
| `canvas` | `#f6f6f6` | `#0e0e11` |
| `sunken` | `#f8f8f8` | `#141417` |
| `subtle` | `#f4f4f4` | `#232327` |
| `skeleton` | `#f1f1f1` | `#242428` |
| `hairline` | `#f0f0f0` | `#202024` |
| `chip` | `#eeeeee` | `#26262b` |
| `separator` | `#ececec` | `#2a2a2f` |
| `pressed` | `#eaeaea` | `#2e2e33` |
| `line` | `#e6e6e6` | `#2c2c31` |
| `line-strong` | `#d8d8d8` | `#3d3d43` |
| `dot` | `#d9dee4` | `#23282e` |
| `scrollbar` | `#dcdcdc` | `#333338` |
| `scrollbar-strong` | `#c8c8c8` | `#4a4a51` |
| `overlay` (nuevo) | `#ffffff` | `#202024` |
| `hover` (nuevo) | `#ffffffb3` | `#ffffff14` |
| `on-strong` (nuevo) | `#ffffff` | `#0e0e11` |
| `tone-red-bg` (nuevo) | `#f8e9e7` | `#2a1a19` |
| `tone-red-ink` (nuevo) | `#a4473f` | `#e0998f` |
| `tone-green-bg` / `tone-green-ink` | `#ecf2e5` / `#667557` | `#1c2418` / `#a9bf93` |
| `tone-blue-bg` / `tone-blue-ink` | `#eaeff6` / `#60738d` | `#1a2129` / `#9fb2cd` |
| `tone-amber-bg` / `tone-amber-ink` | `#f4eee8` / `#8c6850` | `#262019` / `#d3a983` |
| `tone-mauve-bg` / `tone-mauve-ink` | `#f4ebee` / `#8d6270` | `#261d21` / `#cfa2b1` |
| `status-backlog` | `#b4b4b4` | `#6e6e6e` |
| `status-progress` | `#c08a3e` | `#d9a45c` |

Contraste dark medido (WCAG): `ink/surface` 15.8, `ink-soft/surface` 12.2, `muted/surface` 6.8,
`faint/surface` 5.5, `faint/chip` 4.7, `faint/subtle` 4.7, cada `tone-*-ink` sobre su `*-bg` entre
7.2 y 8.0, cada `tone-*-ink` sobre `surface` entre 7.7 y 8.9, `status-progress/surface` 7.9,
`status-backlog/surface` 3.5, `on-strong/ink` 17.2. `backlog` (`#6e6e6e`) queda deliberadamente mas
oscuro que `faint` (`#909090`) para seguir siendo distinguible y menos prominente que `ready`, igual
que en claro.

5. **Logo dark**: se agrega `ui/src/assets/climier-logo-dark.png`, generado desde el original con el
   comando reproducible:
   `magick src/assets/climier-logo.png -channel RGB -fuzz 14% -fill '#f2f2f2' -opaque '#111318' +channel -channel RGB -fuzz 14% -fill '#6f9dff' -opaque '#004cfd' +channel src/assets/climier-logo-dark.png`
   (wordmark claro, chevron azul aclarado a `#6f9dff` para leerse sobre `surface` dark).

6. **Elevaciones** (valores exactos):

| variable | claro | dark |
|---|---|---|
| `--elevation-control` | `0 1px 2px rgb(0 0 0 / 6%)` | `0 1px 2px rgb(0 0 0 / 45%)` |
| `--elevation-edge` | `0 1px 3px rgb(0 0 0 / 6%)` | `0 1px 3px rgb(0 0 0 / 45%)` |
| `--elevation-overlay` | `0 8px 24px rgb(0 0 0 / 10%)` | `0 8px 24px rgb(0 0 0 / 55%)` |
| `--elevation-panel` | `0 8px 28px rgb(0 0 0 / 6%)` | `0 8px 28px rgb(0 0 0 / 45%)` |

## Consecuencias

- A favor: un solo nombre por rol; cero `dark:` en componentes; migracion mecanica y verificable; el
  tema claro conserva sus valores; la arquitectura admite un tercer tema sin tocar componentes.
- A favor: `@theme static` elimina una dependencia fragil ("hoy se emiten los 31 por accidente").
- En contra / deuda: la sintaxis `shadow-[var(--elevation-*)]` es mas verbosa que `shadow-card`; se
  acepta para no introducir `@theme inline`. El tema claro ya incumple AA en algunos pares
  (`faint/surface` 3.45, `muted/canvas` 4.39, `status-backlog` 2.07): no se corrige aca y queda como
  deuda declarada.
- En contra: `--color-hover` conserva `#ffffffb3` en claro para no alterar el hover actual.

## Plan de implementacion

1. Reescribir `ui/src/styles/tokens.css`: `@theme static` con claro + bloque `[data-theme="dark"]`
   sin capa + `color-scheme` + elevaciones.
2. Test de contraste y de invariante del claro (`ui/src/styles/theme-tokens.test.ts`).
3. Commitear `ui/src/assets/climier-logo-dark.png`.

## Onboarding breve para crear tasks

- [x] No hace falta — el ADR fija paths, valores exactos y comandos; las tasks se derivan directo.

## Verificacion

- `cd ui && bun install --frozen-lockfile && bun run typecheck && bun run test:run` en verde.
- `bun run build` y comprobar en el CSS emitido: 35 `--color-*` en el bloque de tema y 35 overrides
  dentro de `[data-theme=dark]`, y `.shadow-\[var\(--elevation-edge\)\]{--tw-shadow:var(--elevation-edge)`.
- El test de contraste calcula ratios desde `getComputedStyle` por tema y falla bajo el umbral AA
  definido en ADR-056.
- El test de invariante compara los valores computados del claro contra los hex actuales de
  `tokens.css` (antes del cambio) y exige igualdad.
