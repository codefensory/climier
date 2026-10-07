import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { For } from "solid-js";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";
import type { KnowledgeGroupMode } from "../data/knowledges";

export type KnowledgeStatusOption = { key: string; label: string; count: number };
export type KnowledgesToolbarProps = {
  status: string;
  statusOptions: KnowledgeStatusOption[];
  onStatus: (status: string) => void;
  query: string;
  onQuery: (query: string) => void;
  group: KnowledgeGroupMode;
  onGroup: (group: KnowledgeGroupMode) => void;
};

export function KnowledgesToolbar(props: KnowledgesToolbarProps) {
  return (
    <div data-testid="knowledges-toolbar" class="flex w-full min-w-0 items-center justify-between gap-2 max-[639px]:flex-wrap max-[639px]:justify-start max-[639px]:gap-x-2 max-[639px]:gap-y-2">
      <div class="hidden min-w-0 overflow-x-auto min-[900px]:block">
        <div class="flex w-max shrink-0 items-center gap-[3px] rounded-[10px] bg-subtle p-[3px]">
          <For each={props.statusOptions}>{(option) => (
            <Button variant="segment" state={props.status === option.key ? "active" : "idle"} aria-pressed={props.status === option.key} onClick={() => props.onStatus(option.key)} class="gap-1 px-1.5 text-[12px] sm:px-2">
              {option.label}<span class="tabular-nums text-faint">{option.count}</span>
            </Button>
          )}</For>
        </div>
      </div>
      <div class="shrink-0 min-[900px]:hidden">
        <select aria-label="Knowledge status" value={props.status} onChange={(event) => props.onStatus(event.currentTarget.value)} class="h-8 w-[156px] rounded-[8px] border border-line bg-surface px-2 text-[12px] text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink">
          <For each={props.statusOptions}>{(option) => <option value={option.key}>{option.label} · {option.count}</option>}</For>
        </select>
      </div>
      <div class="flex min-w-0 shrink-0 items-center gap-1.5 max-[639px]:contents">
        <label class="flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-2 text-muted focus-within:border-line-strong max-[639px]:shrink-0">
          <HugeIcon icon={Search01Icon} class="h-4 w-4 shrink-0" />
          <input type="search" aria-label="Search knowledges" placeholder="Search" value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} class="w-[120px] min-w-0 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint max-[639px]:w-[104px]" />
        </label>
        <select aria-label="Group knowledges" value={props.group} onChange={(event) => props.onGroup(event.currentTarget.value as KnowledgeGroupMode)} class="h-8 max-w-[92px] rounded-[8px] border border-line bg-surface px-1.5 text-[12px] text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink min-[640px]:max-w-none min-[640px]:px-2">
          <option value="initiative">Initiative</option>
          <option value="scope">Scope</option>
        </select>
      </div>
    </div>
  );
}
