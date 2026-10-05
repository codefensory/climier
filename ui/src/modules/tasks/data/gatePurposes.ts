import type { TaskTagStyle } from "../types";

const NEUTRAL_PURPOSE_STYLE: TaskTagStyle = { background: "var(--color-subtle)", color: "var(--color-muted)" };

const PURPOSE_STYLES: Record<string, TaskTagStyle> = {
  decision: NEUTRAL_PURPOSE_STYLE,
  research: NEUTRAL_PURPOSE_STYLE,
  "external-dependency": NEUTRAL_PURPOSE_STYLE,
  approval: NEUTRAL_PURPOSE_STYLE,
};

/** Purpose labels keep a neutral treatment so they cannot read as status or gate-identity tones. */
export function gatePurposeStyle(purpose: string): TaskTagStyle {
  return PURPOSE_STYLES[purpose] ?? NEUTRAL_PURPOSE_STYLE;
}

export function gatePurposeLabel(purpose: string | undefined): string {
  if (!purpose) return "Unspecified";
  return purpose.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
