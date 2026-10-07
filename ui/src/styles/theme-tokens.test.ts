import "./style.css";
import { describe, expect, it } from "vitest";

const LIGHT_TOKENS = {
  ink: "#111111",
  "ink-soft": "#333333",
  muted: "#737373",
  faint: "#8a8a8a",
  ghost: "#d4d4d4",
  surface: "#ffffff",
  raised: "#f8f8f8",
  canvas: "#f6f6f6",
  sunken: "#f2f2f2",
  subtle: "#f4f4f4",
  skeleton: "#f1f1f1",
  hairline: "#f0f0f0",
  chip: "#eeeeee",
  separator: "#ececec",
  pressed: "#eaeaea",
  line: "#e6e6e6",
  "line-strong": "#d8d8d8",
  dot: "#d9dee4",
  scrollbar: "#dcdcdc",
  "scrollbar-strong": "#c8c8c8",
  "tone-green-bg": "#ecf2e5",
  "tone-green-ink": "#667557",
  "tone-blue-bg": "#eaeff6",
  "tone-blue-ink": "#60738d",
  "tone-amber-bg": "#f4eee8",
  "tone-amber-ink": "#8c6850",
  "tone-mauve-bg": "#f4ebee",
  "tone-mauve-ink": "#8d6270",
  "status-backlog": "#b4b4b4",
  "status-progress": "#c08a3e",
} as const;

type Color = [red: number, green: number, blue: number, alpha: number];

function parseColor(value: string): Color {
  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((channel) => channel + channel).join("") : hex;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
      expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    ];
  }

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i)?.[1].split(/[\s,\/]+/).filter(Boolean);
  if (rgb && rgb.length >= 3) {
    const alpha = rgb[3] === undefined ? 1 : Number.parseFloat(rgb[3]);
    return [Number.parseFloat(rgb[0]), Number.parseFloat(rgb[1]), Number.parseFloat(rgb[2]), alpha];
  }

  throw new Error(`Unsupported CSS color: ${value}`);
}

function relativeLuminance(value: Color): number {
  const channels = value.slice(0, 3).map((channel) => channel / 255).map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: Color, background: Color): number {
  const backgroundLuminance = relativeLuminance(background);
  const foregroundLuminance = relativeLuminance(foreground);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function token(name: string): Color {
  return parseColor(getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim());
}

function withTheme(theme: "light" | "dark", check: () => void) {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  root.dataset.theme = theme;
  try {
    check();
  } finally {
    if (previous === undefined) delete root.dataset.theme;
    else root.dataset.theme = previous;
  }
}

describe("theme tokens", () => {
  it("preserves every existing light token value", () => {
    withTheme("light", () => {
      for (const [name, expected] of Object.entries(LIGHT_TOKENS)) {
        expect(getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim()).toBe(expected);
      }
    });
  });

  it("meets the dark-theme WCAG contrast thresholds", () => {
    withTheme("dark", () => {
      const surface = token("surface");
      const canvas = token("canvas");
      const raised = token("raised");
      const subtle = token("subtle");
      const chip = token("chip");

      for (const foreground of ["ink", "ink-soft", "muted"] as const) {
        for (const background of [surface, canvas, raised]) {
          expect(contrast(token(foreground), background)).toBeGreaterThanOrEqual(4.5);
        }
      }

      expect(contrast(token("faint"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("faint"), subtle)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("faint"), chip)).toBeGreaterThanOrEqual(3);

      for (const tone of ["green", "blue", "amber", "mauve"] as const) {
        expect(contrast(token(`tone-${tone}-ink`), token(`tone-${tone}-bg`))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(`tone-${tone}-ink`), surface)).toBeGreaterThanOrEqual(4.5);
      }

      expect(contrast(token("status-progress"), surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(token("status-backlog"), surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(token("on-strong"), token("ink"))).toBeGreaterThanOrEqual(4.5);
    });
  });
});
