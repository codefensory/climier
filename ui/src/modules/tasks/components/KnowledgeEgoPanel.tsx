import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { createEffect, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";
import { Chip } from "../../ui";
import { knowledgeAxisName, knowledgeStatusLabel } from "../data/knowledges";
import type { KnowledgeAxis, KnowledgeRecord } from "../data/knowledges";
import { knowledgeTypeLabel, knowledgeTypeStyle } from "../data/knowledgeTypes";
import { StatusGlyph } from "./StatusGlyph";
import type { KnowledgeLifecycleGlyph } from "./StatusGlyph";

export type KnowledgeEgoPanelProps = {
  knowledge?: KnowledgeRecord;
  onSelect?: (id: string) => void;
  overlay?: boolean;
  onClose?: () => void;
};

const LABEL_CLASS = "text-[10px] font-medium tracking-wide text-muted uppercase";
const lifecycleStyle = (status: KnowledgeRecord["status"]) => status === "active"
  ? { background: "var(--color-tone-blue-bg)", color: "var(--color-tone-blue-ink)" }
  : status === "deprecated"
    ? { background: "var(--color-subtle)", color: "var(--color-tone-mauve-ink)" }
    : { background: "var(--color-subtle)", color: "var(--color-muted)" };

function SectionLabel(props: { children: JSX.Element }) {
  return <h3 class={LABEL_CLASS}>{props.children}</h3>;
}

const AXIS_SINGULAR: Record<KnowledgeAxis, string> = { node: "node ids", domain: "domain", tag: "tag", initiative: "initiative" };
const AXIS_PLURAL: Record<KnowledgeAxis, string> = { node: "node ids", domain: "domains", tag: "tags", initiative: "initiatives" };

function lifecycleGlyph(status: KnowledgeRecord["status"]): "superseded" | KnowledgeLifecycleGlyph {
  return status === "superseded" ? "superseded" : `knowledge_${status}` as KnowledgeLifecycleGlyph;
}

function joinAxisLabels(axes: KnowledgeAxis[]): string {
  const labels = axes.map((axis) => `the ${AXIS_PLURAL[axis]}`);
  if (labels.length < 2) return labels[0] ?? "other declared axes";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function reachNote(record: KnowledgeRecord): string {
  const carrier = record.axes.find((axis) => axis.axis === record.effectiveAxis);
  if (!carrier || !record.effectiveAxis) return "No declared axis currently reaches a node.";
  const axis = record.effectiveAxis;
  if (record.axes.length === 1) return `The ${AXIS_SINGULAR[axis]} axis is the only declared axis and decides the whole reach — ${record.coverage} nodes.`;
  const reach = carrier.count === record.coverage ? `all ${record.coverage} nodes` : `${carrier.count} of ${record.coverage} nodes`;
  if (carrier.count === record.coverage) {
    const broaderAxes = record.axes.filter((entry) => entry.axis !== axis && entry.count > 0).map((entry) => entry.axis);
    const addition = broaderAxes.length ? `${joinAxisLabels(broaderAxes)} add nothing.` : "no other declared axes add nodes.";
    return `The ${AXIS_SINGULAR[axis]} axis decides the reach here — ${reach}; ${addition}`;
  }
  const carrierIds = new Set(carrier.nodeIds);
  const extraIds = new Set(record.coveredIds.filter((id) => !carrierIds.has(id)));
  const seen = new Set<string>();
  const additions = record.axes.filter((entry) => entry.axis !== axis).flatMap((entry) => {
    const count = entry.nodeIds.filter((id) => extraIds.has(id) && !seen.has(id)).length;
    entry.nodeIds.forEach((id) => { if (extraIds.has(id)) seen.add(id); });
    return count > 0 ? [entry.axis] : [];
  });
  return `The ${AXIS_SINGULAR[axis]} axis decides the reach here — ${reach}; ${joinAxisLabels(additions)} add the remaining ${extraIds.size}.`;
}

function ReachedNode(props: { reach: KnowledgeRecord["reaches"][number] }) {
  return (
    <li class="flex min-w-0 items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
      <StatusGlyph status={props.reach.status} class="h-4 w-4 shrink-0" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] leading-5 text-ink">{props.reach.title}</span>
        <span class="block truncate text-[11px] leading-4 text-faint">{props.reach.id} · {props.reach.kind}</span>
      </span>
    </li>
  );
}

export function KnowledgeEgoPanel(props: KnowledgeEgoPanelProps) {
  let panel: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let previousId: string | undefined;
  createEffect(() => {
    const id = props.knowledge?.id;
    const overlay = props.overlay ?? false;
    if (id && previousId && id !== previousId && panel) panel.scrollTop = 0;
    if (overlay && id) closeButton?.focus();
    if (overlay && !id && previousId) {
      [...document.querySelectorAll<HTMLElement>('[data-testid="knowledge-row"]')].find((row) => row.dataset.knowledgeId === previousId)?.focus();
    }
    previousId = id;
  });
  return (
    <aside
      ref={panel}
      data-testid="knowledge-ego"
      class="min-h-0 min-w-0 border-t border-hairline p-4 min-[1024px]:overflow-y-auto min-[1024px]:border-l min-[1024px]:border-t-0 min-[1280px]:col-start-2 min-[1280px]:row-start-1 min-[1280px]:row-span-2"
      classList={{ "registry-detail-overlay": props.overlay, "registry-detail-overlay-open": props.overlay && !!props.knowledge }}
      role={props.overlay && props.knowledge ? "dialog" : undefined}
      aria-modal={props.overlay && props.knowledge ? "true" : undefined}
      aria-label={props.overlay ? props.knowledge?.title : undefined}
      aria-hidden={props.overlay && !props.knowledge}
      inert={props.overlay && !props.knowledge}
      onKeyDown={(event) => { if (props.overlay && event.key === "Escape") { event.preventDefault(); props.onClose?.(); } }}
    >
      <Show when={props.knowledge} fallback={<Show when={!props.overlay}><p class="py-8 text-center text-[12px] text-faint">Select a knowledge to inspect…</p></Show>}>
        {(knowledge) => {
          const record = () => knowledge();
          const scale = () => Math.max(1, record().coverage, ...record().axes.map((axis) => axis.count));
          const body = () => record().body.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
          const effective = () => record().effectiveAxis;
          const typeStyle = () => knowledgeTypeStyle(record().knowledgeType);
          const statusStyle = () => lifecycleStyle(record().status);
          return <div class="min-w-0">
            <section class="relative rounded-[10px] border border-line bg-raised px-3 py-3" classList={{ "pr-12": props.overlay }}>
              <Show when={props.overlay}><Button ref={closeButton} variant="icon" aria-label="Close knowledge details" onClick={() => props.onClose?.()} class="absolute right-2 top-2"><HugeIcon icon={Cancel01Icon} class="h-4 w-4" strokeWidth="1.8" /></Button></Show>
              <div class="flex flex-wrap items-center gap-1.5">
                <Chip background={statusStyle().background} color={statusStyle().color}>{knowledgeStatusLabel(record().status)}</Chip>
                <Chip background={typeStyle().background} color={typeStyle().color}>{knowledgeTypeLabel(record().knowledgeType)}</Chip>
                <Show when={record().initiative}><Chip background="var(--color-subtle)" color="var(--color-muted)">{record().initiative}</Chip></Show>
              </div>
              <h2 class="mt-2 text-[14px] font-medium leading-5 text-ink">{record().title}</h2>
              <p class="mt-1 break-all text-[11px] text-muted">{record().id} · rev {record().revision} · {record().chars} chars</p>
            </section>

            <section class="mt-5 border-t border-hairline pt-4">
              <SectionLabel>Coverage</SectionLabel>
              <div class="mt-2 flex items-baseline gap-2">
                <span class="text-[30px] font-medium leading-none tracking-tight tabular-nums text-ink">{record().coverage}</span>
                <span class="text-[12px] text-muted">nodes reached</span>
              </div>
              <p class="mt-2 text-[12px] text-ink-soft">{record().taskCount} tasks · {record().gateCount} gates</p>
            </section>

            <section class="mt-5 border-t border-hairline pt-4">
              <SectionLabel>Why it applies</SectionLabel>
              <div class="mt-3 flex flex-col gap-3">
                <For each={record().axes}>{(axis) => {
                  const decisive = () => axis.axis === effective();
                  return <div data-axis={axis.axis} class="min-w-0">
                    <div class="flex items-baseline justify-between gap-2">
                      <p class="min-w-0 truncate text-[11px] font-medium text-ink">{knowledgeAxisName(axis.axis)}{decisive() ? <span class="ml-1.5 text-tone-blue-ink">· decides reach</span> : null}</p>
                      <span class="shrink-0 text-[10px] tabular-nums text-muted">{axis.count} {axis.count === 1 ? "node" : "nodes"}</span>
                    </div>
                    <p class="mt-0.5 truncate text-[10px] leading-4 text-faint">{axis.values.join(", ")}</p>
                    <div aria-hidden="true" class="mt-1 h-[3px] overflow-hidden rounded-full bg-subtle">
                      <div class="h-full rounded-full bg-tone-blue-ink" style={{ width: `${Math.min(100, (axis.count / scale()) * 100)}%` }} />
                    </div>
                  </div>;
                }}</For>
                <div class="rounded-[10px] bg-raised px-3 py-2 text-[11px] leading-[17px] text-ink-soft">
                  Applies if <strong>ANY</strong> axis matches; the most specific wins (node &gt; domain &gt; tag &gt; initiative).<br />
                  <Show when={effective()} fallback={<>No declared axis currently reaches a node.</>}>
                    {reachNote(record())}
                  </Show>
                </div>
              </div>
            </section>

            <Show when={body().length > 0}>
              <section class="mt-5 border-t border-hairline pt-4">
                <SectionLabel>Body</SectionLabel>
                <div class="mt-2 flex flex-col gap-2 text-[12px] leading-[18px] text-ink-soft"><For each={body()}>{(paragraph) => <p>{paragraph}</p>}</For></div>
              </section>
            </Show>

            <Show when={record().node.mitigation}>
              <section class="mt-5 border-t border-hairline pt-4"><SectionLabel>Mitigation</SectionLabel><p class="mt-2 text-[12px] leading-[18px] text-ink-soft">{record().node.mitigation}</p></section>
            </Show>

            <Show when={record().reaches.length > 0}>
              <section class="mt-5 border-t border-hairline pt-4">
                <SectionLabel>Reaches (sample)</SectionLabel>
                <ul class="mt-2 flex flex-col gap-2"><For each={record().reaches.slice(0, 5)}>{(reach) => <ReachedNode reach={reach} />}</For></ul>
                <Show when={record().coverage > 5}><p class="mt-2 text-[11px] text-faint">and {record().coverage - 5} more</p></Show>
              </section>
            </Show>

            <Show when={record().supersedeChain.length > 0}>
              <section class="mt-5 border-t border-hairline pt-4">
                <SectionLabel>Supersede chain · {record().supersedeChain.length}</SectionLabel>
                <ol class="mt-2 flex flex-col gap-2">{record().supersedeChain.map((member) => <li class="flex min-w-0 items-center gap-2 rounded-[10px] border border-line px-3 py-2">
                  <StatusGlyph status={lifecycleGlyph(member.status)} class="h-4 w-4 shrink-0" />
                  <button type="button" onClick={() => props.onSelect?.(member.id)} class="min-w-0 flex-1 truncate text-left text-[12px] text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">{member.id}</button>
                  <Show when={member.status !== "superseded"}><Chip background="var(--color-tone-blue-bg)" color="var(--color-tone-blue-ink)">In force</Chip></Show>
                </li>)}</ol>
              </section>
            </Show>
          </div>;
        }}
      </Show>
    </aside>
  );
}
