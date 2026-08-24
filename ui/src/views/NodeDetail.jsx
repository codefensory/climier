import { Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, KindBadge, Chip, Section, fmtTime, lastActionLabel } from "../components.jsx";

const EXPLAIN = {
  ready: "Derived: no unsatisfied blockers — an agent can take this task.",
  blocked: "Derived: at least one BLOCKS edge from an unsatisfied blocker keeps this from being ready.",
  backlog: "Persisted: deliberately kept out of the ready pool until promoted.",
  in_progress: "Persisted: claimed and being worked on.",
  open: "Persisted: a gate (decision/approval/research) that is not resolved yet. It can block tasks via BLOCKS.",
  done: "Persisted: resolved with a verification note.",
  resolved: "Persisted: the gate was closed with a choice and rationale.",
  canceled: "Persisted: terminated without resolving.",
  superseded: "Persisted: replaced by another node via SUPERSEDES.",
  deprecated: "Persisted: no longer applicable; kept for the record.",
};

function EqCommand(props) {
  const { node, derived } = props;
  const id = node.id;
  let cmd = null;
  if (node.kind === "knowledge") cmd = null;
  else if (node.subkind === "gate") cmd = `climier context ${id}   # read blockers, knowledge, allowed actions`;
  else if (node.status === "in_progress") cmd = `climier add-note ${id} "..." --as <agent>`;
  else if (derived === "ready") cmd = `climier take ${id} --as <agent>`;
  else if (derived === "blocked") cmd = `climier context ${id}   # see which blocker gates it`;
  else if (node.status === "done") cmd = `climier reopen ${id} --reason "..." --as <agent>`;
  return <Show when={cmd}><div class="mono rounded bg-ink px-2 py-1.5 text-[11px] text-emerald-300">{cmd}</div></Show>;
}

export default function NodeDetail() {
  const { selectedId, select, detail, detailError } = useStore();
  const d = () => detail();

  return (
    <Show when={selectedId()}>
      <div class="fixed inset-0 z-20 bg-black/40" onClick={() => select(null)} />
      <aside class="fixed right-0 top-0 z-30 flex h-full w-full max-w-2xl flex-col border-l border-line bg-panel shadow-2xl">
        <div class="flex items-center gap-2 border-b border-line px-4 py-3">
          <button class="rounded border border-line bg-panel-2 px-2 py-0.5 text-xs text-slate-300 hover:text-white" onClick={() => select(null)}>✕</button>
          <span class="mono text-sm text-sky-300">{selectedId()}</span>
          <KindBadge kind={d()?.node?.kind} />
          <Show when={d()?.node?.subkind}><span class="text-[11px] uppercase tracking-wider text-slate-500">{d().node.subkind}</span></Show>
          <span class="ml-auto text-[11px] text-slate-500">revision {d()?.node?.revision || 0}</span>
        </div>

        <div class="flex-1 space-y-4 overflow-auto p-4">
          <Show when={detailError()} fallback={<Show when={d()} fallback={<div class="text-sm text-slate-500">Loading…</div>}>
            <div>
              <h2 class="text-lg font-semibold leading-snug text-slate-100">{d().node.title}</h2>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={d().derived_status} />
                <Show when={d().derived_status !== d().node.status}>
                  <span class="text-[11px] text-slate-500">persisted: {d().node.status || "open"}</span>
                </Show>
                <Show when={d().node.initiative}><Chip><span class="text-sky-300">{d().node.initiative}</span></Chip></Show>
                <Show when={d().node.domain}><Chip>{d().node.domain}</Chip></Show>
                <For each={d().node.tags || []}>{(t) => <Chip>#{t}</Chip>}</For>
              </div>
              <Show when={d().node.claim}>
                <div class="mt-2 text-xs text-sky-300">claimed by <span class="mono">{d().node.claim.by}</span> at {fmtTime(d().node.claim.ts)}</div>
              </Show>
              <Show when={EXPLAIN[d().derived_status]}>
                <div class="mt-2 rounded border border-line bg-panel-2 p-2 text-xs text-slate-400">{EXPLAIN[d().derived_status]}</div>
              </Show>
              <div class="mt-3"><EqCommand node={d().node} derived={d().derived_status} /></div>
            </div>

            <Section title="Specification">
              <Show when={d().node.body} fallback={<div class="text-xs text-slate-500">No body.</div>}>
                <div class="whitespace-pre-wrap text-sm text-slate-300">{d().node.body}</div>
              </Show>
              <Show when={d().node.definition}>
                <div class="mt-3">
                  <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">Definition</div>
                  <div class="mt-1 whitespace-pre-wrap text-sm text-slate-300">{d().node.definition}</div>
                </div>
              </Show>
              <Show when={d().node.acceptance}>
                <div class="mt-3">
                  <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">Acceptance</div>
                  <div class="mt-1 whitespace-pre-wrap text-sm text-emerald-200/80">{d().node.acceptance}</div>
                </div>
              </Show>
              <Show when={d().node.resolution}>
                <div class="mt-3 rounded border border-teal-500/30 bg-teal-500/5 p-2">
                  <div class="text-xs font-semibold uppercase tracking-wider text-teal-300">Resolution · {d().node.resolution.choice}</div>
                  <div class="mt-1 text-sm text-slate-300">{d().node.resolution.rationale}</div>
                </div>
              </Show>
            </Section>

            <Section title="Blocking" right={<span class="text-xs text-slate-500">{d().blocking.filter((b) => !b.satisfied).length} unsatisfied</span>}>
              <Show when={d().blocking.length} fallback={<div class="text-xs text-slate-500">No blockers.</div>}>
                <div class="space-y-1.5">
                  <For each={d().blocking}>
                    {(b) => (
                      <button class={`flex w-full items-center gap-2 rounded border p-2 text-left ${b.satisfied ? "border-line opacity-60" : "border-rose-500/40 bg-rose-500/5"}`} onClick={() => select(b.node.id)}>
                        <span class={`h-2 w-2 shrink-0 rounded-full ${b.satisfied ? "bg-emerald-400" : "bg-rose-400"}`} />
                        <span class="mono text-xs text-sky-300">{b.node.id}</span>
                        <span class="truncate text-xs text-slate-300">{b.node.title}</span>
                        <StatusBadge status={b.node.status === "open" && !b.satisfied ? "blocked" : b.node.status} />
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Section title="Dependents">
              <Show when={d().dependents.length} fallback={<div class="text-xs text-slate-500">No dependents.</div>}>
                <div class="space-y-1.5">
                  <For each={d().dependents}>
                    {(dp) => (
                      <button class="flex w-full items-center gap-2 rounded border border-line p-2 text-left hover:border-sky-500/40" onClick={() => select(dp.node.id)}>
                        <span class="mono text-xs text-sky-300">{dp.node.id}</span>
                        <span class="truncate text-xs text-slate-300">{dp.node.title}</span>
                        <span class="ml-auto text-[10px] uppercase text-slate-500">{dp.edge_type}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Section title="Knowledge">
              <Show when={d().knowledge.length} fallback={<div class="text-xs text-slate-500">No scoped knowledge applies.</div>}>
                <div class="space-y-1.5">
                  <For each={d().knowledge}>
                    {(k) => (
                      <button class={`w-full rounded border p-2 text-left ${k.status === "deprecated" ? "border-line opacity-50" : "border-violet-500/30"}`} onClick={() => select(k.id)}>
                        <div class="flex items-center gap-2">
                          <span class="mono text-xs text-violet-300">{k.id}</span>
                          <span class="text-xs font-medium text-slate-200">{k.title}</span>
                          <span class="ml-auto text-[10px] text-slate-500">scope: {k.scope_matches.join(", ")}</span>
                        </div>
                        <Show when={k.body}><div class="mt-1 line-clamp-2 text-xs text-slate-400">{k.body}</div></Show>
                        <Show when={k.mitigation}><div class="mt-0.5 text-[11px] text-teal-300">mitigation: {k.mitigation}</div></Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Section title={`Notes (${d().node.notes?.length || 0})`}>
              <Show when={d().node.notes?.length} fallback={<div class="text-xs text-slate-500">No notes. Append-only thread — evidence and coordination live here.</div>}>
                <div class="space-y-2">
                  <For each={[...(d().node.notes || [])].reverse()}>
                    {(note) => (
                      <div class="rounded border border-line bg-panel-2 p-2">
                        <div class="flex items-center gap-2 text-[11px] text-slate-500">
                          <span class="mono text-sky-300">{note.agent}</span>
                          <span>{fmtTime(note.ts)}</span>
                        </div>
                        <div class="mt-1 whitespace-pre-wrap text-xs text-slate-300">{note.text}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Section title={`History (${d().history.length})`}>
              <div class="space-y-1">
                <For each={[...(d().history || [])].reverse()}>
                  {(h) => (
                    <div class="flex items-center gap-2 text-xs">
                      <span class="mono w-20 shrink-0 text-slate-500">{fmtTime(h.ts)}</span>
                      <span class="mono rounded bg-panel-2 px-1 text-[11px] text-sky-300">{h.action}</span>
                      <span class="mono text-slate-400">{h.agent}</span>
                      <span class="truncate text-slate-500">{h.note}</span>
                    </div>
                  )}
                </For>
              </div>
            </Section>

            <Section title="Refs">
              <Show when={d().refs.length} fallback={<div class="text-xs text-slate-500">No structured refs or detected markdown references.</div>}>
                <div class="space-y-1">
                  <For each={d().refs}>
                    {(r) => <div class="mono truncate text-xs text-sky-300" title={r}>{r}</div>}
                  </For>
                </div>
              </Show>
            </Section>
          </Show>}>
            <div class="text-sm text-rose-300">{detailError()}</div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
