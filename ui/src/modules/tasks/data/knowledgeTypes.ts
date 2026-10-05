import type { TaskTagStyle } from "../types";

const NEUTRAL_KNOWLEDGE_STYLE: TaskTagStyle = { background: "var(--color-subtle)", color: "var(--color-muted)" };

const KNOWLEDGE_TYPES: Record<string, { label: string; style: TaskTagStyle }> = {
  warning: { label: "Warning", style: NEUTRAL_KNOWLEDGE_STYLE },
  note: { label: "Note", style: NEUTRAL_KNOWLEDGE_STYLE },
};

/** Knowledge type chips are neutral labels, never lifecycle or status colors. */
export function knowledgeTypeStyle(type: string): TaskTagStyle {
  return KNOWLEDGE_TYPES[type]?.style ?? NEUTRAL_KNOWLEDGE_STYLE;
}

export function knowledgeTypeLabel(type: string): string {
  return KNOWLEDGE_TYPES[type]?.label ?? type.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
