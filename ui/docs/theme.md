# Theme contract

The UI has one semantic token vocabulary shared by Tailwind classes and runtime CSS. Components must
use these tokens instead of color literals (`bg-surface`, `text-ink`, `var(--color-line)`, etc.).

## Token names

- **Text:** `ink`, `ink-soft`, `muted`, `faint`, `ghost`.
- **Surfaces:** `surface`, `raised`, `canvas`, `sunken`, `subtle`, `skeleton`, `hairline`, `chip`,
  `separator`, `pressed`.
- **Lines and canvas:** `line`, `line-strong`, `dot`, `scrollbar`, `scrollbar-strong`.
- **Tone pairs:** `tone-green-bg` / `tone-green-ink`, `tone-blue-bg` / `tone-blue-ink`,
  `tone-amber-bg` / `tone-amber-ink`, `tone-mauve-bg` / `tone-mauve-ink`, and
  `tone-red-bg` / `tone-red-ink`.
- **Semantic roles:** `overlay`, `hover`, `on-strong`, `status-backlog`, `status-progress`.
- **Elevation variables:** `--elevation-control`, `--elevation-edge`, `--elevation-overlay`,
  `--elevation-panel`.

The font tokens are `font-sans` and `font-display`. Token definitions live in
`src/styles/tokens.css`; it is the only source of color values for component styling.

## Adding a token

1. Choose a semantic role, not a component or page name.
2. Add one value to the light `@theme static` block in `src/styles/tokens.css` and the corresponding
   value to `[data-theme="dark"]`. Do not alias one token to another with `var()`.
3. Use the generated Tailwind utility (`bg-*`, `text-*`, `border-*`) or the CSS variable for runtime
   consumers such as SVG and inline styles.
4. If the token is text or a tone, add its contrast expectation to `src/styles/theme-tokens.test.ts`.

For transparency, use the existing `tint()` helper and `color-mix`; do not introduce `rgba()` or
another embedded color.

## Adding a theme

A theme is a `light` or `dark`-compatible resolved value set selected by `data-theme` on `<html>`.
To add one, extend the `ResolvedTheme` and preference/runtime mapping in `src/modules/core/theme/`,
add its startup selection in `index.html`, provide every semantic token override in `tokens.css`,
and update the contrast tests and the Storybook decorator/toolbar. Keep the preference persisted by
`ThemeProvider` and verify the meta theme color as well.

Runtime precedence is:

1. An explicit `light` or `dark` preference stored at `climier-ui:theme`.
2. For `system`, the OS `prefers-color-scheme` result.
3. The default is light when neither provides a value.

The inline startup script applies the resolved `data-theme` before first paint. `ThemeProvider` then
reconciles it and owns subsequent changes; its resolved value wins over the initial attribute. CSS
`[data-theme]` overrides the light `:root` token values. Storybook's theme global applies the same
attribute for an isolated story.

## Verification

From `ui/` run:

```sh
bun install --frozen-lockfile
bun run check:colors
bun run typecheck
bun run test:run
```

`check:colors` scans `src/` and `.storybook/`, reports `file:line: literal`, and rejects Tailwind
white/black literals, embedded CSS color functions, colored arbitrary shadows, and style color hexes.
Its intentional allowlist is `src/styles/tokens.css`, `.storybook/preview.tsx`, `index.html`, and the
checker itself. To verify the failure path, temporarily add `bg-white` to a scanned source file, run
`bun run check:colors` (it must exit non-zero), and remove the fixture before committing.
