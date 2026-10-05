import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { BREAKPOINTS, useMediaQuery } from "../modules/core";
import { useProjectData } from "../modules/app-shell";
import { GateEgoPanel, GateRow, GatesToolbar, GroupHeader, gateThreadCount, groupGateRecords, projectGateRegistry, statusLabel, useGatesUrl } from "../modules/tasks";
import type { BoardStatus, ClimierSnapshot, GateStatusOption } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

const GATE_STATUS_ORDER: BoardStatus[] = ["open", "resolved", "superseded", "canceled"];

export function GatesPage() {
  const url = useGatesUrl();
  const overlay = useMediaQuery(BREAKPOINTS.registryOverlay);
  const location = useLocation();
  const navigate = useNavigate();
  const projectData = useProjectData();
  const currentSnapshot = () => projectData.snapshot() as ClimierSnapshot;
  const registry = createMemo(() => projectGateRegistry(currentSnapshot()));
  const queryMatches = createMemo(() => {
    const query = url.query().trim().toLocaleLowerCase();
    return registry().filter((gate) => !query || gate.title.toLocaleLowerCase().includes(query) || gate.id.toLocaleLowerCase().includes(query));
  });
  const statusOptions = createMemo<GateStatusOption[]>(() => {
    const counts = new Map<string, number>();
    for (const gate of queryMatches()) counts.set(gate.status, (counts.get(gate.status) ?? 0) + 1);
    const options: GateStatusOption[] = [{ key: "all", label: "All", count: queryMatches().length }];
    for (const [status, count] of [...counts.entries()].sort(([left], [right]) => GATE_STATUS_ORDER.indexOf(left as BoardStatus) - GATE_STATUS_ORDER.indexOf(right as BoardStatus))) {
      if (count > 0) options.push({ key: status, label: statusLabel(status as BoardStatus), count });
    }
    return options;
  });
  const visibleGates = createMemo(() => queryMatches().filter((gate) => url.status() === "all" || gate.status === url.status()));
  const groups = createMemo(() => groupGateRecords(visibleGates(), url.group()));
  const selectedGate = createMemo(() => registry().find((gate) => gate.id === url.selection()));
  const uniqueDownstreamTasks = createMemo(() => new Set(visibleGates().flatMap((gate) => gate.impactedTasks.map((task) => task.id))).size);
  const threads = createMemo(() => gateThreadCount(currentSnapshot(), new Set(visibleGates().map((gate) => gate.id))));

  const gateDetailHref = (id: string) => `/gates/${encodeURIComponent(id)}${location.search}`;
  const openGate = (id: string) => navigate(gateDetailHref(id));

  const toolbar = () => <GatesToolbar
    status={url.status()}
    statusOptions={statusOptions()}
    onStatus={url.setStatus}
    query={url.query()}
    onQuery={url.setQuery}
    group={url.group()}
    onGroup={url.setGroup}
  />;

  return (
    <PageFrame header={toolbar()}>
      <div data-testid="gates-content" class="relative grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[10px] border border-line bg-white min-[1024px]:h-[calc(100vh-9rem)] min-[1280px]:grid-rows-[auto_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(640px,1fr)_380px]">
        <p class="px-4 pb-3 pt-4 text-[14px] text-muted min-[1280px]:col-start-1 min-[1280px]:row-start-1">{visibleGates().length} gates · {visibleGates().filter((gate) => gate.status === "open").length} open · {uniqueDownstreamTasks()} distinct tasks downstream · {threads()} threads</p>
        <section aria-hidden={overlay() && !!selectedGate()} inert={overlay() && !!selectedGate()} class="min-h-0 min-w-0 overflow-y-auto min-[1280px]:col-start-1 min-[1280px]:row-start-2">
          <Show when={groups().length > 0} fallback={<p class="px-4 py-8 text-center text-[13px] text-muted">No gates match these filters.</p>}>
            <div role="listbox" aria-label="Gates" class="divide-y divide-hairline">
              <For each={groups()}>{(group) => (
                <section role="group" aria-label={group.label} data-testid="gate-group" data-group={group.key}>
                  <GroupHeader group={group} />
                  <div class="divide-y divide-hairline [&_[data-testid=gate-row]>div:last-child]:w-max">
                    <For each={group.gates}>{(gate) => <GateRow gate={gate} selected={selectedGate()?.id === gate.id} onSelect={url.setSelection} onOpen={(item) => openGate(item.id)} />}</For>
                  </div>
                </section>
              )}</For>
            </div>
          </Show>
        </section>
        <GateEgoPanel gate={selectedGate()} detailHref={selectedGate() ? gateDetailHref(selectedGate()!.id) : undefined} onOpen={(gate) => openGate(gate.id)} onSelect={url.setSelection} overlay={overlay()} onClose={() => url.setSelection("")} />
      </div>
    </PageFrame>
  );
}
