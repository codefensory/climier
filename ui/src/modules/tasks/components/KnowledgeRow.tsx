import { createEffect, on } from "solid-js";
import { Chip } from "../../ui";
import { knowledgeAxisLabel } from "../data/knowledges";
import type { KnowledgeRecord } from "../data/knowledges";
import { knowledgeTypeLabel, knowledgeTypeStyle } from "../data/knowledgeTypes";
import { StatusGlyph } from "./StatusGlyph";
import type { KnowledgeLifecycleGlyph } from "./StatusGlyph";

export type KnowledgeRowProps = {
  knowledge: KnowledgeRecord;
  selected: boolean;
  onSelect: (id: string) => void;
};

export function KnowledgeRow(props: KnowledgeRowProps) {
  let row: HTMLDivElement | undefined;
  createEffect(on(() => props.selected, (selected) => {
    if (!selected || !row) return;
    let container = row.parentElement;
    while (container && container !== document.body) {
      const overflowY = getComputedStyle(container).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && container.scrollHeight > container.clientHeight) break;
      container = container.parentElement;
    }
    const rowBounds = row.getBoundingClientRect();
    const bounds = container?.getBoundingClientRect();
    if (rowBounds.top < (bounds?.top ?? 0) || rowBounds.bottom > (bounds?.bottom ?? window.innerHeight)) row.scrollIntoView({ block: "nearest" });
  }));
  const typeStyle = () => knowledgeTypeStyle(props.knowledge.knowledgeType);
  const glyphStatus = (): "superseded" | KnowledgeLifecycleGlyph => props.knowledge.status === "superseded" ? "superseded" : `knowledge_${props.knowledge.status}` as KnowledgeLifecycleGlyph;
  return (
    <div
      ref={row}
      data-testid="knowledge-row"
      data-knowledge-id={props.knowledge.id}
      aria-selected={props.selected}
      role="option"
      tabindex="0"
      onClick={() => props.onSelect(props.knowledge.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect(props.knowledge.id);
        }
      }}
      class="flex min-h-[64px] cursor-pointer items-center justify-between gap-3 border-l-2 border-l-transparent px-4 py-2.5 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ink max-[639px]:items-stretch max-[639px]:gap-2"
      classList={{ "border-l-tone-blue-ink bg-tone-blue-bg": props.selected }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-2 max-[639px]:grid max-[639px]:w-[calc(100%_-_78px)] max-[639px]:flex-none max-[639px]:grid-cols-[16px_minmax(0,1fr)_auto] max-[639px]:grid-rows-[auto_auto] max-[639px]:items-center max-[639px]:gap-x-2 max-[639px]:gap-y-0">
        <StatusGlyph status={glyphStatus()} class="h-4 w-4 shrink-0 max-[639px]:col-start-1 max-[639px]:row-start-1" />
        <span class="shrink-0 text-[11px] tabular-nums text-faint max-[639px]:col-start-2 max-[639px]:row-start-2 max-[639px]:block max-[639px]:min-w-0 max-[639px]:max-w-full max-[639px]:truncate">{props.knowledge.id}</span>
        <h3 class="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink max-[639px]:col-start-2 max-[639px]:col-span-2 max-[639px]:row-start-1 max-[639px]:min-w-[150px]">{props.knowledge.title}</h3>
        <span class="inline-flex max-[639px]:col-start-3 max-[639px]:row-start-2"><Chip background={typeStyle().background} color={typeStyle().color}>{knowledgeTypeLabel(props.knowledge.knowledgeType)}</Chip></span>
      </div>
      <div class="w-[70px] shrink-0 whitespace-nowrap text-right tabular-nums max-[639px]:self-end max-[639px]:whitespace-normal">
        <span class="block text-[10px] text-ink-soft">{props.knowledge.coverage} nodes</span>
        <span class="block text-[10px] text-faint">{knowledgeAxisLabel(props.knowledge.declaredAxis)}</span>
      </div>
    </div>
  );
}
