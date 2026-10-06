# RFC: dark mode completo de climier-ui

- Gate: `G-darkmode-rfc` · Iniciativa: `ui-dark-mode` · Estado: aprobado (bloqueos de review resueltos)
- Autor: orchestrator · Fecha: 2026-10-06

## Problema

`ui/` (climier-ui: SolidJS + Vite + Tailwind v4) tiene **un solo tema**. `src/styles/tokens.css`
declara **30 tokens `--color-*`** con literales claros dentro de `@theme`; no hay ningun mecanismo de
tema (ni `prefers-color-scheme`, ni atributo en el documento, ni persistencia, ni control), y **45
archivos** usan literales de color que no dependen de `@theme`: 17 de codigo + 28 stories con
`bg-white`, mas 5 `text-white`, 1 `border-white`, 3 `bg-white/70` y **10 ocurrencias de sombras**
arbitrarias (`shadow-[0_8px_24px_rgb(0_0_0_/_10%)]`).

El repo ya tiene la disciplina correcta para resolverlo: tokens semanticos, "un token por valor",
`@theme` como unica fuente, `tint()` con `color-mix`, y la suite de 209 tests / 46 archivos en verde
(~18 s, Chromium). Lo que falta es la segunda capa de valores y el runtime que la activa.

Evidencia adicional (auditada contra el codigo, no supuesta):

- `ui/src/styles/tokens.css` — 30 tokens de color, todos claros, sin `[data-theme]`.
- `ui/index.html` — `<meta name="theme-color" content="#f7f7f4">`, ademas desactualizado (el canvas
  real es `#f6f6f6`).
- `ui/.storybook/preview.tsx` — `backgrounds` con hex claros fijos; 28 de 37 stories envuelven el
  contenido en `bg-white`, lo que taparia cualquier bug de dark.
- `ui/src/pages/LoginPage.tsx:20` — `text-tone-red-ink` **no existe** en `tokens.css` ni se genera:
  el error de login hoy no tiene color propio (hereda `ink`). Es un bug real.
- `ui/src/assets/climier-logo.png` — wordmark `#111318` + chevron `#004CFD`; sobre fondo oscuro el
  wordmark desaparece. Verificado aplanando el PNG sobre `#18181b`.

## Propuesta

Dark mode por **override de las mismas custom properties** en `[data-theme="dark"]`, mas un runtime
de tema minimo en TypeScript. Piezas:

1. **Tokens de dos temas, sin capa de alias.** `@theme static` conserva los valores claros como
   unica declaracion de nombres y emite **todos** los tokens como custom properties (hoy la emision
   completa es un accidente: tan pronto como un token no tiene consumidor, Tailwind lo tree-shakea).
   Un bloque **un-layered** `[data-theme="dark"]` re-declara los mismos `--color-*`. Verificado con
   Tailwind 4.3.3 real: `@theme` emite en `@layer theme { :root, :host }`, las utilidades compilan a
   `var(--color-*)`, y el bloque sin capa gana por cascada de capas. Los componentes **no** llevan
   `dark:`: siguen usando `bg-surface`, `text-ink`, `border-line`.
2. **Sombras themeables.** A diferencia de `--color-*`, las utilidades `shadow-*` **inlinean** el
   valor claro (`--tw-shadow: 0 8px 24px var(--tw-shadow-color,#0000001a)`), asi que overridear
   `--shadow-*` en dark no cambia nada. Verificado: `shadow-[var(--elevation-card)]` compila a
   `--tw-shadow:var(--elevation-card)` y resuelve por tema. Se usan 4 recetas
   (`--elevation-control|edge|overlay|panel`) definidas en `:root` / `[data-theme=dark]` y
   referenciadas con la forma arbitraria; **no** se usa `@theme inline` (evita el alias `var()` que
   el repo prohibe).
3. **Paleta dark curada** para los 30 tokens + 9 tokens nuevos (`--color-overlay`, `--color-hover`,
   `--color-on-strong`, `--color-tone-red-bg`, `--color-tone-red-ink`) y las 4 elevaciones, con la
   jerarquia de elevacion invertida (canvas mas oscuro → overlay mas claro) y ratios de contraste
   medidos (ver ADR-053). Incluye la variante dark del logo (`climier-logo-dark.png`), ya generada.
4. **Runtime de tema**: atributo `data-theme="light|dark"` en `<html>`; preferencia de **3 estados**
   (`system | light | dark`) persistida en `localStorage` bajo `climier-ui:theme`; `system` sigue a
   `prefers-color-scheme` en vivo; script inline sincrono en `<head>` que aplica el tema **antes del
   primer pintado** (sin FOUC) y sincroniza `color-scheme` + `<meta name="theme-color">`; toda
   lectura/escritura de storage va en `try/catch` (storage bloqueado ⇒ cae a `system`).
5. **Control de tema** en la barra de breadcrumb del shell (siempre visible junto a "Mostrar
   sidebar", no escondido en el footer del sidebar que colapsa): boton icono con menu de 3 opciones,
   `aria-label`, foco visible y `prefers-reduced-motion` respetado.
6. **Cobertura y verificacion**: global de toolbar de Storybook (`light | dark`) con decorator que
   aplica `data-theme` + `color-scheme`; `backgrounds` apagados en el canvas de stories (los hex
   fijos taparian el tema); stories dark dedicadas para las vistas principales (tambien cubiertas por
   axe); test de contraste WCAG que lee las custom properties **computadas** con `getComputedStyle`
   por tema; guard anti-regresion (`ui/scripts/check-colors.mjs`, Node, sin deps) que falla si
   vuelven literales; y la invariante del claro: **los valores computados del claro no cambian**,
   verificados en la suite.

### Que NO cambia en claro

La unica excepcion documentada es el bug de `text-tone-red-ink`: hoy el error de login no tiene color
(la clase no existe). Al crear el par `--color-tone-red-*`, el error pasa a rojo claro. Todo lo demas
del tema claro conserva sus valores hex; el unico cambio de clase es `literal → token de igual
valor` (por ejemplo `bg-white` → `bg-surface`, `shadow-[0 1px 3px rgb(0 0 0 / 6%)]` →
`shadow-[var(--elevation-edge)]` con el mismo valor en claro).

## Alternativas consideradas

| Opcion | Pros | Contras |
|---|---|---|
| **A.** `dark:` variant por componente | el color queda junto al uso | duplica tokens por slot en 45 archivos; rompe "un token por valor"; un caso olvidado no lo ve ningun test |
| **B — recomendada.** Override de las mismas custom properties en `[data-theme=dark]` | un nombre por slot; cero `dark:` en componentes; migracion mecanica y verificable; escala a mas temas | obliga a que todo consumo pase por un token; requiere `@theme static` y sombras via `var()` |
| **C.** `light-dark()` dentro de `@theme` | un solo bloque, sin selector | sube el baseline a Chrome 123 / Safari 17.5 (Tailwind no lo transpila); dificulta el modo `system` explicito |
| **D.** Clase `.dark` en vez de `[data-theme]` | es el default de Tailwind | `data-theme` no colisiona con librerias y admite mas de dos temas; misma complejidad |
| **E.** Libreria de temas | menos codigo | dependencia de runtime prohibida; menos control del no-FOUC |
| **F.** Solo `@media (prefers-color-scheme: dark)`, sin runtime ni control | menos piezas, sin FOUC ni precedencia Storybook | el usuario no puede elegir; la app es una SPA con JS obligatorio, asi que el "sin JS" no aplica; se descarta por UX incompleta |

## Alcance

- **Dentro**: `ui/src/styles/tokens.css`, `ui/src/styles/style.css`, `ui/index.html`,
  `ui/src/modules/core/theme/**` (nuevo), control en `ui/src/modules/app-shell/**`, migracion de
  literales en `ui/src/modules/**` y `ui/src/pages/**` (codigo + stories), `.storybook/**`,
  `ui/src/**/*.test.*`, `ui/scripts/check-colors.mjs`, `ui/src/assets/climier-logo-dark.png`, y
  documentacion de `ui/docs/`.
- **Fuera**: rediseño del tema claro; tipografia, layout y densidad; temas adicionales (alto
  contraste, OLED); el repo standalone `~/dev/climier-ui`; el servidor UI / bridge; el manager de
  Storybook.

**Particion de paths (un dueño por path, sin solapes):**

| Dueño | Paths exclusivos |
|---|---|
| T-tokens | `ui/src/styles/tokens.css`, `ui/src/styles/style.css`, `ui/src/assets/climier-logo-dark.png`, test de contraste |
| T-runtime | `ui/src/modules/core/theme/**`, `ui/index.html`, tests del runtime |
| T-migrate-ui | `ui/src/modules/ui/**`, `ui/src/modules/core/components/**` |
| T-migrate-shell | `ui/src/modules/app-shell/**` **excepto** el control nuevo (T-control) |
| T-migrate-tasks | `ui/src/modules/tasks/**` |
| T-migrate-pages | `ui/src/pages/**` |
| T-control | `ui/src/modules/app-shell/components/ThemeControl.tsx` + su story |
| T-storybook | `ui/.storybook/**`, `ui/src/test-utils/**` |
| T-guards | `ui/scripts/check-colors.mjs`, `package.json` script, `ui/docs/**` |

## Riesgos y open questions

- **Regresion del claro** → invariante: mismo valor computado por token en claro. Verificado en la
  suite con `getComputedStyle` sobre las custom properties (no con un instrumento externo), mas los
  209 tests existentes y axe.
- **FOUC** → script inline sincrono en `<head>`; evidencia: captura con `data-theme` dark desde el
  primer frame.
- **Contraste insuficiente en dark** → umbral absoluto AA: texto primario ≥ 4.5:1 sobre sus
  superficies; metadatos (`faint`) ≥ 4.5 sobre `surface`/`subtle` y ≥ 3 sobre `chip`; graficos y
  status ≥ 3:1. El claro ya tiene pares bajo 4.5 (`faint` 3.45, `muted` 4.39 sobre canvas, backlog
  2.07); **no se corrige el claro en esta iniciativa** (queda como deuda declarada).
- **`tint()` con `color-mix` en dark**: los tintes 7–15% son la señal primaria de agrupacion
  (`GroupHeader`, `TaskActivityFeed`), **no son cortables**; se validan con capturas y, si
  desaparecen, se sube el alpha por tema o se agregan tokens de tinte.
- **Logo** → se agrega `climier-logo-dark.png` (generado con ImageMagick a partir del original,
  comando reproducible en ADR-053) y se alterna por CSS; el logo es legible en ambos temas.
- **Costo por task** → el worktree del runner nace sin `ui/node_modules`; toda acceptance empieza
  con `cd ui && bun install --frozen-lockfile`. Chromium ya esta cacheado.
- **Precedencia Storybook vs `ThemeProvider`** → el provider resuelve en este orden: preferencia
  explicita guardada → `data-theme` preexistente en `<html>` (lo pone el script inline o el decorator
  de Storybook) → `prefers-color-scheme`. Asi no pisa al toolbar.
- **Open**: ninguno bloqueante. Decisiones cerradas: 3 estados si; control en el breadcrumb;
  `--color-hover` conserva el `#ffffffb3` del claro para no alterar el hover; 4 elevaciones (cada
  literal distinto conserva su valor claro); el par rojo corrige el bug de login.

## Resolucion de review (2026-10-06)

- **[arquitectura] Sombras**: el bloqueo era correcto. Se verifica y documenta el mecanismo
  `shadow-[var(--elevation-*)]`; se descarta `@theme inline` por el alias `var()`. Queda en §Propuesta 2.
- **[arquitectura] `@theme static`**: confirmado que Tailwind tree-shakea tokens sin consumidor; se
  adopta `static`. Queda en §Propuesta 1.
- **[arquitectura] Precedencia del provider**: se cierra con el orden de resolucion en §Riesgos.
- **[arquitectura] Alternativa mas simple (F)**: evaluada y descartada por UX; registrada en
  §Alternativas.
- **[ejecucion] Invariante del claro reproducible**: se reemplaza el instrumento ad-hoc
  (`ego-browser` + Storybook + `dom/`) por un test en la suite que lee custom properties computadas
  por tema; la firma de color del DOM deja de ser acceptance de task (la validacion visual final la
  hace el orquestador con `ego-browser`). Queda en §Propuesta 6 y §Riesgos.
- **[ejecucion] Guard y contraste implementables**: el guard es un script Node
  (`ui/scripts/check-colors.mjs`) y el contraste un test del project browser; ambos corren en
  `bun run test:run` o en el script del guard. Queda en §Alcance.
- **[ejecucion] `bun install` en acceptance**: incorporado a §Riesgos.
- **[ejecucion] Scopes que se pisaban**: se resuelve con la tabla de particion de §Alcance.
- **[ejecucion] Conteos**: corregidos a 30 tokens `--color-*`, 45 archivos y 10 sombras.
- **[producto] Logo**: deja de ser "verificar"; entra en alcance con la variante dark generada.
  Queda en §Propuesta 3.
- **[producto] Default y storage**: `system` cuando no hay clave y `try/catch` alrededor de storage.
  Queda en §Propuesta 4.
- **[producto] Alcanzabilidad del control**: el control va al breadcrumb, siempre visible, no al
  footer del sidebar que colapsa. Queda en §Propuesta 5.
- **[producto] Umbral de contraste absoluto**: adoptado (AA), sin exigir cambios en el claro.
  Queda en §Riesgos.
- **[producto] Tintes y 4 tonos**: se mantienen; los tintes no son cortables y los 4 tonos de avatar
  se verifican distinguibles en dark. Queda en §Riesgos.
- **[producto] Agujero del audit (`text-tone-red-ink`)**: entra como correccion explicita del par
  rojo. Queda en §Que NO cambia en claro.
- **[producto] Cortes**: se mantienen las 4 elevaciones porque consolidarlas alteraria el claro; se
  corta el `backgrounds` por tema del manager (se apaga en el canvas).

## ADRs derivados (se completa al aprobar)

- [x] ADR-053: Arquitectura de tokens de dos temas, paleta dark y elevaciones → `.adrs/053-ui-dark-tokens.md`
- [x] ADR-054: Runtime de tema (data-theme, preferencia de 3 estados, persistencia, sin FOUC) → `.adrs/054-ui-theme-runtime.md`
- [x] ADR-055: Control de tema en la UI y variante dark del logo → `.adrs/055-ui-theme-control.md`
- [x] ADR-056: Cobertura en Storybook y estrategia de verificacion → `.adrs/056-ui-dark-verification.md`
