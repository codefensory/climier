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
  /**
   * Iniciativa terminada: no le queda ninguna gate pendiente.
   *
   * El 100% es el mismo que dibuja la barra del `GroupHeader` (`groupGateRecords` cuenta resueltas y
   * superseded), así que lo que se oculta es exactamente lo que el grupo muestra como 100%.
   */
  const completedGroups = createMemo(() => url.group() === "initiative" ? groups().filter((group) => group.progress >= 100) : []);
  const visibleGroups = createMemo(() => url.group() === "initiative" && !url.showCompleted() ? groups().filter((group) => group.progress < 100) : groups());
  /** Gates efectivamente listadas: los contadores del encabezado siguen lo visible, no el registry completo. */
  const listedGates = createMemo(() => visibleGroups().flatMap((group) => group.gates));
  const selectedGate = createMemo(() => registry().find((gate) => gate.id === url.selection()));
  const uniqueDownstreamTasks = createMemo(() => new Set(listedGates().flatMap((gate) => gate.impactedTasks.map((task) => task.id))).size);
  const threads = createMemo(() => gateThreadCount(currentSnapshot(), new Set(listedGates().map((gate) => gate.id))));

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
      <div data-testid="gates-content" class="relative grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden min-[1024px]:h-[var(--page-frame-content-height)] min-[1280px]:grid-rows-[auto_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(640px,1fr)_380px]">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pb-3 pt-4 min-[1280px]:col-start-1 min-[1280px]:row-start-1">
          <p class="text-[14px] text-muted">{listedGates().length} gates · {listedGates().filter((gate) => gate.status === "open").length} open · {uniqueDownstreamTasks()} distinct tasks downstream · {threads()} threads</p>
          <Show when={completedGroups().length > 0}>
            <button
              type="button"
              data-testid="gates-show-completed"
              aria-expanded={url.showCompleted()}
              onClick={() => url.setShowCompleted(!url.showCompleted())}
              class="rounded-[10px] px-2 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              {url.showCompleted() ? "Show less" : `Show ${completedGroups().length} completed`}
            </button>
          </Show>
        </div>
        <section aria-hidden={overlay() && !!selectedGate()} inert={overlay() && !!selectedGate()} class="min-h-0 min-w-0 overflow-y-auto min-[1280px]:col-start-1 min-[1280px]:row-start-2">
          <Show when={visibleGroups().length > 0} fallback={<p class="px-4 py-8 text-center text-[13px] text-muted">{completedGroups().length > 0 ? "All initiatives are complete." : "No gates match these filters."}</p>}>
            <div class="divide-y divide-hairline">
              <For each={visibleGroups()}>{(group) => (
                <section role="group" aria-label={group.label} data-testid="gate-group" data-group={group.key}>
                  <GroupHeader group={group} />
                  <div role="listbox" aria-label={`${group.label} gates`} class="divide-y divide-hairline [&_[data-testid=gate-row]>div:last-child]:w-max">
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
