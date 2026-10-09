import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const themePath = resolve(import.meta.dirname, 'theme.css');
const tokensPath = resolve(import.meta.dirname, '../../../ui/src/styles/tokens.css');

const lightPalette = {
  background: 'canvas',
  foreground: 'ink',
  muted: 'subtle',
  'muted-foreground': 'muted',
  card: 'surface',
  'card-foreground': 'ink',
  popover: 'surface',
  'popover-foreground': 'ink',
  border: 'line',
  primary: 'ink',
  'primary-foreground': 'surface',
  secondary: 'subtle',
  'secondary-foreground': 'ink',
  accent: 'pressed',
  'accent-foreground': 'ink',
  ring: 'line-strong',
  info: 'tone-blue-ink',
  success: 'tone-green-ink',
  warning: 'tone-amber-ink',
  error: 'tone-red-ink',
};

const darkPalette = { ...lightPalette, 'primary-foreground': 'canvas' };

function declarations(css: string, selector: string): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 's'))?.[1];
  assert.ok(block, `missing ${selector} block in ${themePath}`);

  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

function sourceDeclarations(css: string, selector: string): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 's'))?.[1];
  assert.ok(block, `missing ${selector} block in ${tokensPath}`);

  return Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

function assertPaletteMatches(
  theme: Record<string, string>,
  tokens: Record<string, string>,
  palette: Record<string, string>,
  selector: string,
) {
  for (const [fumadocsName, uiName] of Object.entries(palette)) {
    assert.equal(
      theme[`color-fd-${fumadocsName}`],
      tokens[uiName],
      `${selector}: --color-fd-${fumadocsName} must map ui --color-${uiName}`,
    );
  }
}

test('maps the light and dark ui palette into Fumadocs variables', () => {
  const theme = readFileSync(themePath, 'utf8');
  const tokens = readFileSync(tokensPath, 'utf8');

  assertPaletteMatches(
    declarations(theme, ':root'),
    sourceDeclarations(tokens, '@theme static'),
    lightPalette,
    ':root',
  );

  assertPaletteMatches(
    declarations(theme, '[data-theme="dark"], .dark'),
    sourceDeclarations(tokens, '[data-theme="dark"]'),
    darkPalette,
    '[data-theme="dark"], .dark',
  );
});

test('keeps the documented typography roles', () => {
  const theme = readFileSync(themePath, 'utf8');

  assert.match(theme, /--font-sans:\s*["']DM Sans["']/);
  assert.match(theme, /--font-display:\s*["']Manrope["']/);
});
