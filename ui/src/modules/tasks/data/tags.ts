import type { TaskTagStyle } from "../types";

/**
 * Paleta curada de tags. Lo que no está acá lo resuelve `taskTag()` con un tono derivado y estable.
 *
 * En climier un tag es el campo `tags` del node (antes los llamábamos "labels" en la UI). El
 * vocabulario es el de climier.
 */
export const tagStyles: Record<string, TaskTagStyle> = {
  design: { background: "var(--color-tone-green-bg)", color: "var(--color-tone-green-ink)" },
  accessibility: { background: "var(--color-tone-mauve-bg)", color: "var(--color-tone-mauve-ink)" },
  platform: { background: "var(--color-tone-blue-bg)", color: "var(--color-tone-blue-ink)" },
  auth: { background: "var(--color-tone-mauve-bg)", color: "var(--color-tone-mauve-ink)" },
  billing: { background: "var(--color-tone-amber-bg)", color: "var(--color-tone-amber-ink)" },
  checkout: { background: "var(--color-tone-blue-bg)", color: "var(--color-tone-blue-ink)" },
  docs: { background: "var(--color-tone-amber-bg)", color: "var(--color-tone-amber-ink)" },
  growth: { background: "var(--color-tone-mauve-bg)", color: "var(--color-tone-mauve-ink)" },
};

const TAG_TONES = ["green", "mauve", "blue", "amber"] as const;

/** Hash determinista: el mismo tag recibe el mismo tono siempre, en cualquier sesión. */
function toneFor(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) hash = (hash * 31 + tag.charCodeAt(index)) % 997;
  return TAG_TONES[hash % TAG_TONES.length];
}

/**
 * Estilo del chip de un tag.
 *
 * Un tag fuera del mapa recibe un tono derivado y estable en vez de tirar `TypeError` y caer la
 * vista entera.
 */
export function taskTag(tag: string): TaskTagStyle {
  const known = tagStyles[tag];
  if (known) return known;
  const tone = toneFor(tag);
  return { background: `var(--color-tone-${tone}-bg)`, color: `var(--color-tone-${tone}-ink)` };
}
