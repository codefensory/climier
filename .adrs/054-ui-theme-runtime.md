# ADR-054: Runtime de tema con preferencia de 3 estados y sin FOUC

- Gate: `G-adr-theme-runtime` · Deriva de: `G-darkmode-rfc` · Estado: aprobado
- Fecha: 2026-10-06

## Contexto

El atributo `data-theme` en `<html>` activa el tema oscuro (ADR-053). Falta quien lo ponga: la
preferencia del usuario, el default de sistema, la persistencia y —critico para UX— que el tema
correcto este aplicado **antes del primer pintado**. La app es una SPA de SolidJS con entry en
`ui/index.html` + `ui/src/index.tsx`. `core` ya aloja providers (`RuntimeProvider`,
`SessionProvider`) y la primitiva `useMediaQuery`; `SessionProvider` ya usa un patron de storage
inyectable y testeable.

Ver RFC `.decisions/G-darkmode-rfc.md` §Propuesta 4 y §Riesgos (precedencia).

## Decision

Nuevo modulo `ui/src/modules/core/theme/` (infraestructura sin semantica visual, misma capa que los
otros providers de `core`):

1. **Tipos y clave de storage.**
   - `THEME_STORAGE_KEY = "climier-ui:theme"`.
   - `type ThemePreference = "system" | "light" | "dark"`; `type ResolvedTheme = "light" | "dark"`.
2. **Logica pura, testeable sin DOM.**
   - `resolveTheme(preference, systemPrefersDark): ResolvedTheme`.
   - `readStoredPreference(storage?): ThemePreference` — `try/catch` alrededor de `localStorage`;
     cualquier error o valor invalido devuelve `"system"`.
   - `applyTheme(root, resolved)` escribe `root.dataset.theme`.
   - `META_THEME_COLOR: Record<ResolvedTheme, string>` = `{ light: "#f6f6f6", dark: "#0e0e11" }`
     (el `canvas` de cada tema).
3. **Provider.** `ThemeProvider` + `useTheme()` exponen `{ preference, resolved, setPreference }`.
   - Preferencia inicial, en este orden: storage → `data-theme` ya presente en `<html>` (lo puso el
     script inline o el decorator de Storybook) → `system`.
   - `system` sigue a `prefers-color-scheme` **en vivo** reutilizando `useMediaQuery`.
   - `setPreference` persiste (en `try/catch`; si storage falla, aplica igual en memoria) y aplica.
   - Sincroniza `<meta name="theme-color">` con `META_THEME_COLOR[resolved]` en cada cambio.
   - `color-scheme` lo maneja el CSS por `[data-theme]` (ADR-053); el JS no lo escribe.
4. **Script inline en `ui/index.html`** dentro del `<head>`, antes de cualquier recurso que pinte:
   lee la clave de storage con `try/catch`, resuelve contra `matchMedia("(prefers-color-scheme: dark)")`,
   setea `document.documentElement.dataset.theme` y actualiza el `meta[name=theme-color]`. Sin
   imports, sin dependencias, sin esperar a Vite.
5. **Montaje.** `ThemeProvider` envuelve el arbol en `ui/src/App.tsx` (junto a `RuntimeProvider`),
   no en `index.tsx`, para que `App.stories.tsx` (que monta `<App/>`) lo tenga y el control del
   shell nunca quede fuera de contexto.
6. **Precedencia con Storybook resuelta por el orden de init:** el `ThemeProvider` adopta el
   `data-theme` preexistente que puso el decorator del toolbar y no lo pisa hasta que el usuario
   cambie la preferencia.

## Consecuencias

- A favor: sin FOUC (el atributo existe antes del primer frame); default `system` sin decision del
  usuario; preferencia explicita persistente; storage roto no rompe el boot.
- A favor: logica pura separada del DOM, testeable con `storage` inyectable como en `SessionProvider`.
- En contra / deuda: el script inline duplica la clave de storage y la resolucion minima; es una
  duplicacion chica y deliberada (no se puede importar un modulo ESM desde un `<script>` inline
  antes de Vite). Un test verifica que la clave del script coincide con `THEME_STORAGE_KEY`.

## Plan de implementacion

1. `ui/src/modules/core/theme/theme.ts` (puro) + `ThemeProvider.tsx` + `index.ts` (exports
   explicitos, sin `export *`; el modulo se exporta desde `ui/src/modules/core/index.ts`).
2. `ui/index.html`: script inline + default de `data-theme` + `meta` coherente.
3. `ui/src/App.tsx`: envolver con `ThemeProvider`.
4. Tests: `theme.test.ts` (tabla de resolucion, valores invalidos, storage que tira) y
   `ThemeProvider.test.tsx` (adopta `data-theme` preexistente, cambia y persiste, sigue el sistema).

## Onboarding breve para crear tasks

- [x] No hace falta — paths, API y criterios quedan cerrados.

## Verificacion

- `cd ui && bun install --frozen-lockfile && bun run typecheck && bun run test:run` en verde, con los
  tests nuevos del runtime incluidos.
- Manual: cargar la app con `climier-ui:theme = "dark"` y con el SO en dark, y comprobar que el
  primer frame ya es oscuro (sin flash claro) y que `<meta name="theme-color">` coincide con el canvas.
- El script inline y `THEME_STORAGE_KEY` comparten la misma clave (test).
