import { createMemo, For, Show } from "solid-js";
import { BREAKPOINTS, useMediaQuery } from "../modules/core";
import { useProjectData } from "../modules/app-shell";
import { GroupHeader, KnowledgeEgoPanel, KnowledgeRow, KnowledgesToolbar, groupKnowledgeRecords, knowledgeRegistrySummary, projectKnowledgeRegistry, useKnowledgesUrl } from "../modules/tasks";
import type { ClimierSnapshot, KnowledgeStatusOption } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

const STATUS_ORDER = ["active", "superseded", "deprecated"];
const STATUS_LABELS: Record<string, string> = { active: "Active", superseded: "Superseded", deprecated: "Deprecated" };

export function KnowledgesPage() {
  const url = useKnowledgesUrl();
  const overlay = useMediaQuery(BREAKPOINTS.registryOverlay);
  const projectData = useProjectData();
  const currentSnapshot = () => projectData.snapshot() as ClimierSnapshot;
  const registry = createMemo(() => projectKnowledgeRegistry(currentSnapshot()));
  const summary = createMemo(() => knowledgeRegistrySummary(currentSnapshot(), registry()));
  const queryMatches = createMemo(() => {
    const query = url.query().trim().toLocaleLowerCase();
    return registry().filter((knowledge) => !query || knowledge.title.toLocaleLowerCase().includes(query) || knowledge.id.toLocaleLowerCase().includes(query));
  });
  const statusOptions = createMemo<KnowledgeStatusOption[]>(() => {
    const counts = new Map<string, number>();
    for (const knowledge of queryMatches()) counts.set(knowledge.status, (counts.get(knowledge.status) ?? 0) + 1);
    const options: KnowledgeStatusOption[] = [{ key: "all", label: "All", count: queryMatches().length }];
    for (const status of STATUS_ORDER) {
      const count = counts.get(status) ?? 0;
      if (count > 0) options.push({ key: status, label: STATUS_LABELS[status], count });
    }
    return options;
  });
  const visibleKnowledges = createMemo(() => queryMatches().filter((knowledge) => url.status() === "all" || knowledge.status === url.status()));
  const groups = createMemo(() => groupKnowledgeRecords(visibleKnowledges(), url.group()));
  const selectedKnowledge = createMemo(() => registry().find((knowledge) => knowledge.id === url.selection()));
  const leftSummary = () => [
    summary().active > 0 ? `${summary().active} active` : null,
    summary().superseded > 0 ? `${summary().superseded} superseded` : null,
    `${summary().coveredNodes} of ${summary().resolvableNodes} nodes covered`,
  ].filter(Boolean).join(" · ");
  const rightSummary = () => [
    summary().supersessionChains > 0 ? `${summary().supersessionChains} supersession chains` : null,
    summary().initiativesWithoutKnowledge > 0 ? `${summary().initiativesWithoutKnowledge} initiatives without knowledge` : null,
  ].filter(Boolean).join(" · ");

  const toolbar = () => <KnowledgesToolbar
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
      <div data-testid="knowledges-content" class="relative grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden min-[1024px]:h-[var(--page-frame-content-height)] min-[1280px]:grid-rows-[auto_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(640px,1fr)_380px]">
        <div data-testid="knowledges-summary" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pb-3 pt-4 text-[12px] text-muted min-[1280px]:col-start-1 min-[1280px]:row-start-1">
          <p>{leftSummary()}</p>
          <Show when={rightSummary()}><p class="ml-auto text-right">{rightSummary()}</p></Show>
        </div>
        <section aria-hidden={overlay() && !!selectedKnowledge()} inert={overlay() && !!selectedKnowledge()} class="min-h-0 min-w-0 overflow-y-auto min-[1280px]:col-start-1 min-[1280px]:row-start-2">
          <Show when={groups().length > 0} fallback={<p class="px-4 py-8 text-center text-[13px] text-muted">No knowledges match these filters.</p>}>
            <div class="divide-y divide-hairline">
              <For each={groups()}>{(group) => (
                <section role="group" aria-label={group.label} data-testid="knowledge-group" data-group={group.key}>
                  <GroupHeader group={group} />
                  <div role="listbox" aria-label={`${group.label} knowledges`} class="divide-y divide-hairline [&_[data-testid=knowledge-row]>div:last-child]:w-max">
                    <For each={group.knowledges}>{(knowledge) => <KnowledgeRow knowledge={knowledge} selected={selectedKnowledge()?.id === knowledge.id} onSelect={url.setSelection} />}</For>
                  </div>
                </section>
              )}</For>
            </div>
          </Show>
        </section>
        <KnowledgeEgoPanel knowledge={selectedKnowledge()} onSelect={url.setSelection} overlay={overlay()} onClose={() => url.setSelection("")} />
      </div>
    </PageFrame>
  );
}
