import { STATUS_TOKENS } from "../data/statuses";
import type { BoardStatus } from "../types";

/**
 * Hexágono de estado: el único SVG propio que queda, y `AGENTS.md` lo autoriza explícitamente.
 * Hugeicons no tiene un equivalente con todas las variantes internas (punteado, medio lleno,
 * flecha, barra, lleno).
 *
 * Cubre tasks y gates: `open`/`resolved`/`superseded` son las gates, el resto las tasks.
 * La forma se dibuja igual en todas las variantes: sólo cambian el color y qué va adentro, por eso
 * es una constante compartida y el `d` no se repite.
 */
const statusHexagon = "M8 1.6 13.5 4.8 13.5 11.2 8 14.4 2.5 11.2 2.5 4.8Z";

export type KnowledgeLifecycleGlyph = "knowledge_active" | "knowledge_deprecated";

export type StatusGlyphProps = {
  status: BoardStatus | KnowledgeLifecycleGlyph;
  /** Por defecto `h-4 w-4 shrink-0`. */
  class?: string;
};

/**
 * Los colores salen de `STATUS_TOKENS` y no de literales: la misma tabla la usa `statusOrder` para
 * teñir los grupos, así que el color de un estado se declara una sola vez.
 */
export function StatusGlyph(props: StatusGlyphProps) {
  return (
    <svg class={props.class ?? "h-4 w-4 shrink-0"} viewBox="0 0 16 16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.status === "backlog" && <path d={statusHexagon} stroke={STATUS_TOKENS.backlog} stroke-dasharray="3.4 1.6" />}
      {props.status === "ready" && <path d={statusHexagon} stroke={STATUS_TOKENS.ready} />}
      {props.status === "in_progress" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.in_progress} />
        <path d="M3.3 10 12.7 10 12.4 11.4 8 13.7 3.6 11.4Z" fill={STATUS_TOKENS.in_progress} stroke="none" />
      </>)}
      {props.status === "submitted" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.submitted} />
        <path d="M5.3 9.8 8 7 10.7 9.8" stroke={STATUS_TOKENS.submitted} />
      </>)}
      {props.status === "blocked" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.blocked} />
        <path d="M6.2 10.4 9.8 5.6" stroke={STATUS_TOKENS.blocked} />
      </>)}
      {props.status === "done" && (<>
        <path d={statusHexagon} fill={STATUS_TOKENS.done} stroke={STATUS_TOKENS.done} />
        <path d="m5.3 8.1 1.8 1.8 3.6-3.8" stroke="var(--color-surface)" />
      </>)}
      {props.status === "canceled" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.canceled} stroke-dasharray="3.4 1.6" />
        <path d="M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9" stroke={STATUS_TOKENS.canceled} />
      </>)}
      {props.status === "archived" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.archived} />
        <path d="M5.4 8h5.2" stroke={STATUS_TOKENS.archived} />
      </>)}
      {props.status === "open" && (<>
        <path d={statusHexagon} stroke={STATUS_TOKENS.open} />
        <path d="M8 5.6 10.2 8 8 10.4 5.8 8Z" stroke={STATUS_TOKENS.open} />
      </>)}
      {props.status === "resolved" && (<>
        <path d={statusHexagon} fill={STATUS_TOKENS.resolved} stroke={STATUS_TOKENS.resolved} />
        <path d="m5.3 8.1 1.8 1.8 3.6-3.8" stroke="var(--color-surface)" />
      </>)}
      {props.status === "superseded" && <path d={statusHexagon} stroke={STATUS_TOKENS.superseded} stroke-dasharray="3.4 1.6" />}
      {props.status === "knowledge_active" && <><path d={statusHexagon} stroke="var(--color-tone-blue-ink)" /><circle cx="8" cy="8" r="1.5" fill="var(--color-tone-blue-ink)" stroke="none" /></>}
      {props.status === "knowledge_deprecated" && <><path d={statusHexagon} stroke="var(--color-tone-mauve-ink)" /><path d="M6 6 10 10M10 6 6 10" stroke="var(--color-tone-mauve-ink)" /></>}
    </svg>
  );
}
