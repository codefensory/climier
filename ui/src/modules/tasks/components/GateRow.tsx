import { createEffect, on } from "solid-js";
import { Chip } from "../../ui";
import { gatePurposeStyle } from "../data/gatePurposes";
import { StatusGlyph } from "./StatusGlyph";
import type { GateRecord } from "../data/gates";

export type GateRowProps = {
  gate: GateRecord;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpen?: (gate: GateRecord) => void;
};

/** Selectable registry row with the established task-list rhythm. */
export function GateRow(props: GateRowProps) {
  let row: HTMLDivElement | undefined;
  const purpose = () => gatePurposeStyle(props.gate.purpose);
  createEffect(on(() => props.selected, (selected) => {
    if (!selected || !row) return;
    let scrollContainer = row.parentElement;
    while (scrollContainer && scrollContainer !== document.body) {
      const overflowY = getComputedStyle(scrollContainer).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && scrollContainer.scrollHeight > scrollContainer.clientHeight) break;
      scrollContainer = scrollContainer.parentElement;
    }
    const rowBounds = row.getBoundingClientRect();
    const containerBounds = scrollContainer?.getBoundingClientRect();
    const visibleTop = containerBounds?.top ?? 0;
    const visibleBottom = containerBounds?.bottom ?? window.innerHeight;
    if (rowBounds.top < visibleTop || rowBounds.bottom > visibleBottom) row.scrollIntoView({ block: "nearest" });
  }));
  return (
    <div
      ref={row}
      data-testid="gate-row"
      data-gate-id={props.gate.id}
      aria-selected={props.selected}
      aria-keyshortcuts="Shift+Enter"
      aria-description="Press Shift+Enter to open gate details."
      role="option"
      tabindex="0"
      onClick={() => props.onSelect(props.gate.id)}
      onDblClick={() => props.onOpen?.(props.gate)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          props.onOpen?.(props.gate);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect(props.gate.id);
        }
      }}
      class="flex min-h-[64px] cursor-pointer items-center justify-between gap-3 border-l-2 border-l-transparent px-4 py-2.5 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ink max-[639px]:flex-col max-[639px]:items-stretch max-[639px]:gap-2"
      classList={{ "border-l-tone-blue-ink bg-tone-blue-bg": props.selected }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-2 max-[639px]:grid max-[639px]:w-full max-[639px]:flex-none max-[639px]:grid-cols-[16px_minmax(0,1fr)_auto] max-[639px]:grid-rows-[auto_auto] max-[639px]:items-center max-[639px]:gap-x-2 max-[639px]:gap-y-0">
        <StatusGlyph status={props.gate.status} class="h-4 w-4 shrink-0 max-[639px]:col-start-1 max-[639px]:row-start-1" />
        <span class="shrink-0 text-[11px] tabular-nums text-faint max-[639px]:col-start-2 max-[639px]:row-start-2 max-[639px]:block max-[639px]:min-w-0 max-[639px]:max-w-full max-[639px]:truncate">{props.gate.id}</span>
        <h3 class="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink max-[639px]:col-start-2 max-[639px]:col-span-2 max-[639px]:row-start-1 max-[639px]:whitespace-normal max-[639px]:line-clamp-2">{props.gate.title}</h3>
        <span class="inline-flex max-[639px]:col-start-3 max-[639px]:row-start-2"><Chip background={purpose().background} color={purpose().color}>{props.gate.purposeLabel}</Chip></span>
      </div>
      <div class="w-16 shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-ink-soft max-[639px]:w-full max-[639px]:self-start max-[639px]:text-left max-[639px]:whitespace-normal">
        {props.gate.impactTasks} {props.gate.impactTasks === 1 ? "task" : "tasks"}
        {props.gate.impactGates > 0 && <> · {props.gate.impactGates} {props.gate.impactGates === 1 ? "gate" : "gates"}</>}
      </div>
    </div>
  );
}
