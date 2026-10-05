import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import { For, Show } from "solid-js";
import { HugeIcon } from "../../core";
import { statusLabel } from "../data/statuses";
import { gatePurposeLabel } from "../data/gatePurposes";
import type { GateRecord, GateRelation } from "../data/gates";
import { formatUpdatedAt } from "../utils/formatUpdatedAt";
import { StatusGlyph } from "./StatusGlyph";
import { TaskActivityFeed } from "./TaskActivityFeed";
import { TaskCommentComposer } from "./TaskCommentComposer";
import { TaskProperties } from "./TaskProperties";
import { TaskReferenceList } from "./TaskReferenceList";
import { GroupHeader } from "./GroupHeader";
import { taskGroups } from "../utils/taskGroups";
import type { TaskBlocker, TaskDependent, TaskDetail, TaskKnowledge } from "../types";

export type TaskDetailViewProps = {
  detail: TaskDetail;
  gateInfo?: { record: GateRecord; resolutionMode: string };
  /** Si no se pasa, el botón de volver no se renderiza (una story aislada no tiene a dónde volver). */
  onBack?: () => void;
  onOpenNode?: (id: string, kind: "task" | "gate") => void;
  onSubmitComment?: (comment: string) => void;
};

type NodeRowProps = {
  id: string;
  title: string;
  status: TaskBlocker["status"];
  kind: TaskBlocker["kind"];
  meta: string;
  onOpenNode?: (id: string, kind: "task" | "gate") => void;
};

function NodeIdentity(props: Pick<NodeRowProps, "id" | "title" | "status" | "meta">) {
  return <>
    <StatusGlyph status={props.status} class="h-4 w-4 shrink-0" />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] leading-5 text-ink">{props.title}</span>
      <span class="block truncate text-[11px] leading-4 text-faint">{props.id} · {props.meta}</span>
    </span>
  </>;
}

/** Fila de un node relacionado: los nodes con detalle son enlaces navegables. */
function NodeRow(props: NodeRowProps) {
  const href = () => `/${props.kind === "gate" ? "gates" : "tasks"}/${encodeURIComponent(props.id)}`;
  const navigable = () => props.kind !== "knowledge" && props.onOpenNode !== undefined;
  return (
    <li class="rounded-[10px] border border-line">
      <Show when={navigable()} fallback={<div class="flex items-center gap-2.5 px-3 py-2"><NodeIdentity {...props} /></div>}>
        <a href={href()} aria-label={props.title} onClick={(event) => { event.preventDefault(); props.onOpenNode?.(props.id, props.kind as "task" | "gate"); }} class="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          <NodeIdentity {...props} />
        </a>
      </Show>
    </li>
  );
}

function gateRelationMeta(node: GateRelation): string {
  const status = statusLabel(node.status);
  return node.kind === "gate" && node.purpose ? `${status} · ${gatePurposeLabel(node.purpose)}` : status;
}

function GateDetailArticle(props: TaskDetailViewProps & { gateInfo: { record: GateRecord; resolutionMode: string } }) {
  const task = () => props.detail.task;
  const gate = () => props.gateInfo.record;
  const downstreamGroups = () => taskGroups(gate().impactedTasks, "status", { key: "updated", dir: "desc" }).filter((group) => group.tasks.length > 0);
  const decisionMessage = () => gate().status === "open"
    ? "No decision yet; this gate is open."
    : `No decision recorded; this gate is ${statusLabel(gate().status).toLowerCase()}.`;
  return (
    <article class="mx-auto w-full max-w-[640px] pb-4 md:max-w-[880px]">
      <header>
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-[5px] bg-tone-amber-bg px-2 py-[2px] text-[11px] font-medium tracking-wide text-tone-amber-ink uppercase">Gate{gate().purpose ? ` · ${gatePurposeLabel(gate().purpose)}` : ""}</span>
          <h1 class="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink">{task().title}</h1>
        </div>
        <div class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] leading-4 text-faint">
          <span class="inline-flex items-center gap-1.5"><StatusGlyph status={task().status} class="h-3.5 w-3.5" />{statusLabel(task().status)}</span>
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{task().id}</span>
          <span aria-hidden="true">·</span>
          <span>Last activity {formatUpdatedAt(task().updatedAt)}</span>
        </div>
      </header>

      <div class="mt-8 grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,1fr)_240px]">
        <div class="min-w-0">
          <section>
            <h2 class="text-[13px] leading-5 font-medium text-ink">Decision</h2>
            <Show when={gate().status === "resolved" && (gate().choice || gate().rationale)} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">{decisionMessage()}</p>}>
              <div class="mt-3 rounded-[10px] border border-line bg-raised px-3 py-3">
                <Show when={gate().choice}>
                  <div>
                    <p class="text-[11px] font-medium text-muted">Choice</p>
                    <p class="mt-1 text-[14px] font-medium leading-5 text-ink">{gate().choice}</p>
                  </div>
                </Show>
                <Show when={gate().rationale}>
                  <div class="mt-3">
                    <p class="text-[11px] font-medium text-muted">Rationale</p>
                    <p class="mt-1 text-[13px] leading-5 text-ink-soft">{gate().rationale}</p>
                  </div>
                </Show>
              </div>
            </Show>
          </section>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Blocked by</h2>
            <Show when={props.detail.blockers.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">Nothing blocks this gate.</p>}>
              <ul class="mt-3 flex flex-col gap-2">
                <For each={props.detail.blockers}>{(blocker) => <NodeRow id={blocker.id} title={blocker.title} status={blocker.status} kind={blocker.kind} meta={`${statusLabel(blocker.status)} · ${blocker.satisfied ? "satisfied" : "unsatisfied"}`} onOpenNode={props.onOpenNode} />}</For>
              </ul>
            </Show>
          </section>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Unblocks gates · {gate().downstreamGates.length}</h2>
            <Show when={gate().downstreamGates.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">No downstream gates.</p>}>
              <ul class="mt-3 flex flex-col gap-2"><For each={gate().downstreamGates}>{(node) => <NodeRow id={node.id} title={node.title} status={node.status} kind={node.kind} meta={gateRelationMeta(node)} onOpenNode={props.onOpenNode} />}</For></ul>
            </Show>
          </section>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Opens work in · {gate().impactedTasks.length} {gate().impactedTasks.length === 1 ? "task" : "tasks"}</h2>
            <Show when={gate().impactedTasks.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">No downstream tasks.</p>}>
              <div class="mt-3 overflow-hidden rounded-[10px] border border-line">
                <For each={downstreamGroups()}>{(group) => {
                  const collapse = gate().impactedTasks.length >= 10 && group.tasks.length > 1 && (group.key === "done" || group.key === "canceled");
                  return <section>
                    <Show when={collapse} fallback={
                      <>
                        <GroupHeader group={group} />
                        <ul class="flex flex-col gap-2 p-2"><For each={group.tasks}>{(node) => <NodeRow id={node.id} title={node.title} status={node.status} kind={node.kind} meta={gateRelationMeta(node)} onOpenNode={props.onOpenNode} />}</For></ul>
                      </>
                    }>
                      <details>
                        <summary class="cursor-pointer"><GroupHeader group={group} /></summary>
                        <ul class="flex flex-col gap-2 p-2"><For each={group.tasks}>{(node) => <NodeRow id={node.id} title={node.title} status={node.status} kind={node.kind} meta={gateRelationMeta(node)} onOpenNode={props.onOpenNode} />}</For></ul>
                      </details>
                    </Show>
                  </section>;
                }}</For>
              </div>
            </Show>
          </section>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Background</h2>
            <Show when={props.detail.body.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">No background recorded.</p>}>
              <div class="mt-3 space-y-4 text-[14px] leading-[22px] text-ink-soft"><For each={props.detail.body}>{(paragraph) => <p>{paragraph}</p>}</For></div>
            </Show>
          </section>

          <Show when={gate().supersedeChain.length > 0}>
            <section class="mt-8">
              <h2 class="text-[13px] leading-5 font-medium text-ink">Supersede chain · {gate().supersedeChain.length}</h2>
              <ul class="mt-3 flex flex-col gap-2"><For each={gate().supersedeChain}>{(node) => <NodeRow id={node.id} title={node.title} status={node.status} kind={node.kind} meta={gateRelationMeta(node)} onOpenNode={props.onOpenNode} />}</For></ul>
            </section>
          </Show>

          <section class="mt-8 border-t border-hairline pt-6">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Activity · {props.detail.activity.length}</h2>
            <Show when={props.detail.activity.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">No activity yet.</p>}>
              <div class="mt-4"><TaskActivityFeed activity={props.detail.activity} /></div>
            </Show>
            <div class="mt-6"><TaskCommentComposer onSubmit={props.onSubmitComment} /></div>
          </section>
        </div>
        <aside class="min-w-0 border-t border-hairline pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
          <TaskProperties task={task()} purpose={gate().purpose} resolutionMode={props.gateInfo.resolutionMode} />
          <div class="mt-8"><TaskReferenceList references={props.detail.refs} /></div>
        </aside>
      </div>
    </article>
  );
}

/**
 * Vista de detalle de una tarea.
 *
 * Es presentacional pura: recibe el `TaskDetail` ya proyectado y callbacks. Resolver el id contra el
 * snapshot es trabajo de la página, que es la que tiene el router.
 *
 * Las secciones son las del modelo de climier: **Specification** (body + acceptance),
 * **Blocking**, **Dependents**, **Knowledge**, **Activity/Notes** y **References**. La columna
 * derecha queda para propiedades y referencias; el resto se lee como una página.
 */
export function TaskDetailView(props: TaskDetailViewProps) {
  if (props.gateInfo) return <GateDetailArticle {...props} gateInfo={props.gateInfo} />;
  const task = () => props.detail.task;
  return (
    <article class="mx-auto w-full max-w-[640px] pb-4 md:max-w-[880px]">
      <Show when={props.onBack}>
        <button type="button" onClick={() => props.onBack?.()} class="inline-flex items-center gap-1 rounded-[6px] text-[13px] leading-5 text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          <HugeIcon icon={ArrowLeft01Icon} class="h-4 w-4" strokeWidth="1.8" />
          Tasks
        </button>
      </Show>
      <header classList={{ "mt-6": props.onBack !== undefined }}>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={task().kind === "gate"}>
            <span class="rounded-[5px] bg-tone-amber-bg px-2 py-[2px] text-[11px] font-medium tracking-wide text-tone-amber-ink uppercase">Gate{task().purpose ? ` · ${task().purpose}` : ""}</span>
          </Show>
          <h1 class="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink">{task().title}</h1>
        </div>
        <div class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] leading-4 text-faint">
          <span class="inline-flex items-center gap-1.5">
            <StatusGlyph status={task().status} class="h-3.5 w-3.5" />
            {statusLabel(task().status)}
          </span>
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{task().id}</span>
          <span aria-hidden="true">·</span>
          <span>Last activity {formatUpdatedAt(task().updatedAt)}</span>
        </div>
      </header>
      <div class="mt-8 grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,1fr)_240px]">
        <div class="min-w-0">
          <Show when={props.detail.body.length > 0}>
            <div class="space-y-4 text-[14px] leading-[22px] text-ink-soft">
              <For each={props.detail.body}>{(paragraph) => <p>{paragraph}</p>}</For>
            </div>
          </Show>

          <Show when={props.detail.acceptance}>
            <section class="mt-8">
              <h2 class="text-[13px] leading-5 font-medium text-ink">Acceptance</h2>
              <p class="mt-3 rounded-[10px] border border-line bg-raised px-3 py-2 text-[13px] leading-5 text-ink-soft">{props.detail.acceptance}</p>
            </section>
          </Show>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Blocked by</h2>
            <Show when={props.detail.blockers.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">Nothing blocks this node.</p>}>
              <ul class="mt-3 flex flex-col gap-2">
                <For each={props.detail.blockers}>{(blocker: TaskBlocker) => <NodeRow id={blocker.id} title={blocker.title} status={blocker.status} kind={blocker.kind} meta={blocker.satisfied ? "satisfied" : "unsatisfied"} onOpenNode={props.onOpenNode} />}</For>
              </ul>
            </Show>
          </section>

          <section class="mt-8">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Dependents</h2>
            <Show when={props.detail.dependents.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">Nothing depends on this node.</p>}>
              <ul class="mt-3 flex flex-col gap-2">
                <For each={props.detail.dependents}>{(dependent: TaskDependent) => <NodeRow id={dependent.id} title={dependent.title} status={dependent.status} kind={dependent.kind} meta={dependent.edgeType.toLowerCase()} onOpenNode={props.onOpenNode} />}</For>
              </ul>
            </Show>
          </section>

          <Show when={props.detail.knowledge.length > 0}>
            <section class="mt-8">
              <h2 class="text-[13px] leading-5 font-medium text-ink">Knowledge</h2>
              <ul class="mt-3 flex flex-col gap-2">
                <For each={props.detail.knowledge}>{(item: TaskKnowledge) => (
                  <li class="rounded-[10px] border border-line px-3 py-2">
                    <div class="flex items-center gap-2">
                      <span class="rounded-[5px] bg-subtle px-1.5 py-[1px] text-[10px] font-medium tracking-wide text-muted uppercase">{item.knowledgeType}</span>
                      <span class="truncate text-[13px] leading-5 text-ink">{item.title}</span>
                    </div>
                    <p class="mt-1.5 text-[12px] leading-[18px] text-muted">{item.body}</p>
                    <p class="mt-1.5 text-[11px] leading-4 text-faint">Applies by {item.scopeMatches.join(", ")}{item.status === "deprecated" ? " · deprecated" : ""}</p>
                  </li>
                )}</For>
              </ul>
            </section>
          </Show>

          <section class="mt-10 border-t border-hairline pt-6">
            <h2 class="text-[13px] leading-5 font-medium text-ink">Activity</h2>
            <div class="mt-4"><TaskActivityFeed activity={props.detail.activity} /></div>
            <div class="mt-6"><TaskCommentComposer onSubmit={props.onSubmitComment} /></div>
          </section>
        </div>
        <aside class="min-w-0 border-t border-hairline pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
          <TaskProperties task={task()} />
          <div class="mt-8"><TaskReferenceList references={props.detail.refs} /></div>
        </aside>
      </div>
    </article>
  );
}
