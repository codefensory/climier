import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { createEffect, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";
import { gatePurposeLabel } from "../data/gatePurposes";
import { statusLabel } from "../data/statuses";
import type { GateRecord, GateRelation } from "../data/gates";
import type { BoardStatus } from "../types";
import { StatusGlyph } from "./StatusGlyph";

export type GateEgoPanelProps = {
  gate?: GateRecord;
  detailHref?: string;
  onOpen?: (gate: GateRecord) => void;
  onSelect?: (id: string) => void;
  overlay?: boolean;
  onClose?: () => void;
};

const LABEL_CLASS = "text-[10px] font-medium tracking-wide text-muted uppercase";

function SectionLabel(props: { children: JSX.Element }) {
  return <h3 class={LABEL_CLASS}>{props.children}</h3>;
}

function relationMeta(node: GateRelation): string {
  const status = statusLabel(node.status);
  return node.kind === "gate" && node.purpose ? `${status} · ${gatePurposeLabel(node.purpose)}` : status;
}

const STATUS_PRIORITY: Partial<Record<BoardStatus, number>> = {
  blocked: 0,
  in_progress: 1,
  submitted: 2,
  ready: 3,
  backlog: 4,
  done: 5,
  canceled: 6,
  archived: 7,
};

function taskStatusSummary(tasks: GateRelation[]): string[] {
  const counts = new Map<BoardStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => (STATUS_PRIORITY[left] ?? 8) - (STATUS_PRIORITY[right] ?? 8))
    .map(([status, count]) => `${count} ${statusLabel(status).toLowerCase()}`);
}

function NodeRow(props: { node: GateRelation; onSelect?: (id: string) => void }) {
  return (
    <li class="flex min-w-0 items-center gap-2.5 rounded-[10px] bg-raised px-3 py-2">
      {props.node.kind === "gate" && props.onSelect ? (
        <button type="button" onClick={() => props.onSelect?.(props.node.id)} class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[6px] text-left transition-colors hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          <StatusGlyph status={props.node.status} class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] leading-5 text-ink underline underline-offset-2">{props.node.title}</span>
            <span class="block truncate text-[11px] leading-4 text-faint">{props.node.id} · {relationMeta(props.node)}</span>
          </span>
        </button>
      ) : <>
        <StatusGlyph status={props.node.status} class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] leading-5 text-ink">{props.node.title}</span>
          <span class="block truncate text-[11px] leading-4 text-faint">{props.node.id} · {relationMeta(props.node)}</span>
        </span>
      </>}
    </li>
  );
}

function Fact(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-3 max-[639px]:grid max-[639px]:grid-cols-[104px_minmax(0,1fr)] max-[639px]:items-start max-[639px]:gap-2">
      <dt class={LABEL_CLASS}>{props.label}</dt>
      <dd class="min-w-0 truncate text-right text-[12px] font-medium text-ink max-[639px]:overflow-visible max-[639px]:text-left max-[639px]:whitespace-normal max-[639px]:break-words">{props.value}</dd>
    </div>
  );
}

/** Readable top-to-bottom ego view: blockers, selected hinge, then distinct downstream facts. */
export function GateEgoPanel(props: GateEgoPanelProps) {
  let panel: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let previousId: string | undefined;
  createEffect(() => {
    const id = props.gate?.id;
    const overlay = props.overlay ?? false;
    if (id && previousId && id !== previousId && panel) panel.scrollTop = 0;
    if (overlay && id) closeButton?.focus();
    if (overlay && !id && previousId) {
      [...document.querySelectorAll<HTMLElement>('[data-testid="gate-row"]')].find((row) => row.dataset.gateId === previousId)?.focus();
    }
    previousId = id;
  });
  return (
    <aside
      ref={panel}
      data-testid="gate-ego"
      class="min-h-0 min-w-0 border-t border-hairline p-4 min-[1024px]:overflow-y-auto min-[1024px]:border-l min-[1024px]:border-t-0 min-[1280px]:col-start-2 min-[1280px]:row-start-1 min-[1280px]:row-span-2"
      classList={{ "registry-detail-overlay": props.overlay, "registry-detail-overlay-open": props.overlay && !!props.gate }}
      role={props.overlay && props.gate ? "dialog" : undefined}
      aria-modal={props.overlay && props.gate ? "true" : undefined}
      aria-label={props.overlay ? props.gate?.title : undefined}
      aria-hidden={props.overlay && !props.gate}
      inert={props.overlay && !props.gate}
      onKeyDown={(event) => { if (props.overlay && event.key === "Escape") { event.preventDefault(); props.onClose?.(); } }}
    >
      <Show when={props.gate} fallback={<Show when={!props.overlay}><p class="py-8 text-center text-[12px] text-faint">Select a gate to inspect its relationships.</p></Show>}>
        {(gate) => {
          const hasRelations = () => gate().blockedBy.length > 0 || gate().downstreamGates.length > 0 || gate().impactedTasks.length > 0 || gate().supersedeChain.length > 0;
          return <div class="min-w-0">
            <div class="relative pl-5">
              <div aria-hidden="true" class="absolute bottom-3 left-[7px] top-3 w-px bg-line" />
              <Show when={gate().blockedBy.length > 0}>
                <section class="relative mb-4">
                  <SectionLabel>Blocked by · {gate().blockedBy.length}</SectionLabel>
                  <ul class="mt-2 flex flex-col gap-2"><For each={gate().blockedBy}>{(node) => <NodeRow node={node} onSelect={props.onSelect} />}</For></ul>
                </section>
              </Show>

              <section class="relative -ml-5 rounded-[10px] bg-raised px-3 py-3" classList={{ "pr-12": props.overlay }}>
                <Show when={props.overlay}><Button ref={closeButton} variant="icon" aria-label="Close gate details" onClick={() => props.onClose?.()} class="absolute right-2 top-2"><HugeIcon icon={Cancel01Icon} class="h-4 w-4" strokeWidth="1.8" /></Button></Show>
                <p class="text-[10px] font-medium tracking-wide text-muted">{gate().id.toLowerCase()}</p>
                <div class="mt-1 flex items-start justify-between gap-2">
                  <Show when={props.detailHref} fallback={<h2 class="text-[14px] font-medium leading-5 text-ink">{gate().title}</h2>}>
                    <a href={props.detailHref} onClick={(event) => { event.preventDefault(); props.onOpen?.(gate()); }} class="min-w-0 flex-1 cursor-pointer text-[14px] font-medium leading-5 text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">{gate().title}</a>
                  </Show>
                  <Show when={props.detailHref}>
                    <button type="button" onClick={() => props.onOpen?.(gate())} class="shrink-0 rounded-[6px] text-[11px] font-medium text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">Open full detail</button>
                  </Show>
                </div>
                <p class="mt-1 text-[11px] text-muted">{gate().purposeLabel} · {gate().statusLabel}</p>
              </section>

              <Show when={gate().downstreamGates.length > 0}>
                <section class="relative mt-4">
                  <SectionLabel>Unblocks gates · {gate().downstreamGates.length}</SectionLabel>
                  <ul class="mt-2 flex flex-col gap-2"><For each={gate().downstreamGates}>{(node) => <NodeRow node={node} onSelect={props.onSelect} />}</For></ul>
                </section>
              </Show>
              <Show when={gate().impactedTasks.length > 0}>
                <section class="relative mt-4">
                  <SectionLabel>Opens work in · {gate().impactedTasks.length} {gate().impactedTasks.length === 1 ? "task" : "tasks"}</SectionLabel>
                  <div class="mt-2 w-fit rounded-[10px] bg-raised px-3 py-2">
                    <div class="grid gap-x-3 gap-y-1 text-[11px] leading-4 text-ink-soft" style={{ "grid-template-columns": `repeat(${taskStatusSummary(gate().impactedTasks).length <= 4 ? taskStatusSummary(gate().impactedTasks).length : 3}, max-content)` }}>
                      <For each={taskStatusSummary(gate().impactedTasks)}>{(status) => <span class="whitespace-nowrap tabular-nums">{status}</span>}</For>
                    </div>
                  </div>
                </section>
              </Show>
              <Show when={!hasRelations()}>
                <p class="relative mt-4 text-[12px] text-faint">No linked gates or tasks.</p>
              </Show>
            </div>

            <Show when={gate().status === "resolved" && (gate().choice || gate().rationale)}>
              <section class="mt-5 border-t border-hairline pt-4">
                <SectionLabel>Decision</SectionLabel>
                <Show when={gate().choice}>
                  <div class="mt-2">
                    <p class={LABEL_CLASS}>Choice</p>
                    <p class="mt-1 text-[13px] font-medium leading-5 text-ink">{gate().choice}</p>
                  </div>
                </Show>
                <Show when={gate().rationale}>
                  <div class="mt-2">
                    <p class={LABEL_CLASS}>Rationale</p>
                    <p class="mt-1 text-[12px] leading-[18px] text-ink-soft">{gate().rationale}</p>
                  </div>
                </Show>
              </section>
            </Show>

            <section class="mt-5 border-t border-hairline pt-4">
              <SectionLabel>Context</SectionLabel>
              <dl class="mt-3 space-y-2">
                <Fact label="Initiative" value={gate().initiative ?? "Unassigned"} />
                <Fact label="Purpose" value={gate().purposeLabel} />
                <Fact label="Revision" value={gate().task.revision} />
                <Fact label="Notes" value={gate().task.notes} />
              </dl>
            </section>

            <Show when={gate().supersedeChain.length > 0}>
              <section class="mt-5 border-t border-hairline pt-4">
                <SectionLabel>Supersede chain · {gate().supersedeChain.length}</SectionLabel>
                <ul class="mt-2 flex flex-col gap-2"><For each={gate().supersedeChain}>{(node) => <NodeRow node={node} onSelect={props.onSelect} />}</For></ul>
              </section>
            </Show>
          </div>;
        }}
      </Show>
    </aside>
  );
}
