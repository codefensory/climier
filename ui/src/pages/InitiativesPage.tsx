import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { HugeIcon } from "../modules/core";
import { useProjectData } from "../modules/app-shell";
import { encodeFilterTree, formatUpdatedAt, groupProgress, projectBoard, StatusGlyph } from "../modules/tasks";
import type { ClimierSnapshot, FilterGroup } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

type InitiativeRow = {
  name: string;
  desc: string;
  total: number;
  open: number;
  blocked: number;
  gates: number;
  updated: string;
  /** ISO del último cambio; `updated` es la versión formateada y esto lo que ordena. */
  updatedAt: string;
  progress: number;
};

const SETTLED = new Set(["done", "canceled", "archived"]);

/** Resumen por iniciativa, derivado del board (tasks + gates). */
function initiativeRows(snapshot: ClimierSnapshot): InitiativeRow[] {
  const board = projectBoard(snapshot);
  return Object.keys(snapshot.initiatives)
    .map((name) => {
      const tasks = board.tasks.filter((task) => task.initiative === name);
      const gates = board.gates.filter((gate) => gate.initiative === name);
      const updatedAt = [...tasks, ...gates].map((task) => task.updatedAt).filter(Boolean).sort().at(-1) ?? "";
      return {
        name,
        desc: snapshot.initiatives[name].desc,
        total: tasks.length,
        open: tasks.filter((task) => !SETTLED.has(task.status)).length,
        blocked: tasks.filter((task) => task.status === "blocked").length,
        gates: gates.length,
        updated: formatUpdatedAt(updatedAt),
        updatedAt,
        progress: groupProgress([...tasks, ...gates]),
      };
    })
    // Orden por `Updated` descendente: lo último que se movió arriba. Sin actividad (`""`) al final.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.total - left.total || left.name.localeCompare(right.name));
}

/**
 * Initiatives: el trabajo agrupado por iniciativa.
 *
 * Al elegir una, navega a `/tasks` con el **mismo** árbol de filtros que escribe el panel
 * (`?filter=…`), así que la vista de tasks se abre ya acotada y el estado es compartible y
 * recargable. No hay una segunda ruta de filtrado: se reutiliza la que el board ya entiende.
 */
export function InitiativesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const projectData = useProjectData();
  const currentSnapshot = () => projectData.snapshot() as ClimierSnapshot;
  const rows = createMemo(() => initiativeRows(currentSnapshot()));
  const [showCompleted, setShowCompleted] = createSignal(false);
  const completedRows = createMemo(() => rows().filter((row) => row.progress >= 100));
  const visibleRows = createMemo(() => showCompleted() ? rows() : rows().filter((row) => row.progress < 100));
  const openTaskCount = createMemo(() => visibleRows().reduce((total, row) => total + row.open, 0));
  const blockedTaskCount = createMemo(() => visibleRows().reduce((total, row) => total + row.blocked, 0));

  const openInitiative = (initiative: string) => {
    const tree: FilterGroup = {
      id: "group-root",
      join: "and",
      conditions: [{ id: "initiative-1", join: "and", field: "initiative", operator: "is", values: [initiative] }],
      groups: [],
    };
    const search = new URLSearchParams(location.search);
    search.set("filter", encodeFilterTree(tree) ?? "");
    navigate(`/tasks?${search.toString()}`);
  };

  return (
    <PageFrame>
      <p class="mb-5 text-[14px] text-muted">{visibleRows().length} initiatives · {openTaskCount()} open tasks · {blockedTaskCount()} blocked</p>
      <div>
          <div class="hidden min-h-[38px] grid-cols-[minmax(0,1fr)_88px_72px_112px] items-center gap-3 border-b border-hairline px-4 min-[640px]:grid min-[1024px]:grid-cols-[minmax(0,1fr)_88px_72px_76px_112px]">
            <span class="text-[11px] font-medium text-muted">Initiative</span>
            <span class="text-right text-[11px] font-medium text-muted">Tasks</span>
            <span class="text-right text-[11px] font-medium text-muted">Gates</span>
            <span class="hidden text-right text-[11px] font-medium text-muted min-[1024px]:block">Updated</span>
            <span class="text-right text-[11px] font-medium text-muted">Progress</span>
          </div>
          <div class="divide-y divide-hairline">
            <For each={visibleRows()}>{(row) => (
              <div
                data-testid="initiative-card"
                data-initiative={row.name}
                data-progress={row.progress}
                tabindex="0"
                role="button"
                onClick={() => openInitiative(row.name)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openInitiative(row.name); } }}
                class="min-h-[58px] cursor-pointer px-3 py-2 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ink min-[640px]:flex min-[640px]:items-center min-[640px]:px-4 min-[640px]:py-0"
              >
                <div class="hidden w-full grid-cols-[minmax(0,1fr)_88px_72px_112px] items-center gap-3 min-[640px]:grid min-[1024px]:grid-cols-[minmax(0,1fr)_88px_72px_76px_112px]">
                  <div class="flex min-w-0 items-center">
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-[14px] font-medium leading-[18px] text-ink">{row.name}</div>
                      <div class="truncate text-[12px] leading-4 text-muted">{row.desc}</div>
                    </div>
                  </div>
                  <div class="text-right">
                    <div class="flex items-baseline justify-end gap-1 whitespace-nowrap">
                      <span class="text-[13px] tabular-nums text-ink-soft">{row.open}</span>
                      <span class="text-[12px] text-muted">of {row.total}</span>
                    </div>
                    <Show when={row.blocked > 0}><div class="flex items-center justify-end gap-1 whitespace-nowrap text-[12px] text-tone-mauve-ink"><StatusGlyph status="blocked" class="h-3.5 w-3.5 shrink-0" />{row.blocked} blocked</div></Show>
                  </div>
                  <div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
                    <Show when={row.gates > 0} fallback={<span class="text-[12px] text-muted">—</span>}>
                      <HugeIcon icon={SecurityCheckIcon} class="h-3.5 w-3.5 shrink-0 text-tone-amber-ink" />
                      <span class="text-[13px] tabular-nums text-ink">{row.gates}</span>
                    </Show>
                  </div>
                  <div class="hidden text-right text-[12px] tabular-nums text-muted min-[1024px]:block">{row.updated}</div>
                  <div class="flex w-full min-w-0 items-center justify-end gap-2">
                    <div class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-hairline"><div class="h-full rounded-full bg-tone-blue-ink" style={{ width: `${row.progress}%` }} /></div>
                    <span class="w-7 shrink-0 text-right text-[11px] tabular-nums text-ink-soft">{row.progress}%</span>
                  </div>
                </div>
                <div class="flex min-w-0 flex-col gap-1 min-[640px]:hidden">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <span class="shrink-0 text-[13px] font-medium text-ink">{row.name}</span>
                    <span class="truncate text-[12px] text-muted">{row.desc}</span>
                  </div>
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-soft">{row.open} of {row.total}</span>
                    <Show when={row.blocked > 0}><span class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-tone-mauve-ink"><StatusGlyph status="blocked" class="h-3.5 w-3.5 shrink-0" />{row.blocked} blocked</span></Show>
                    <span class="flex shrink-0 items-center gap-1 whitespace-nowrap">
                      <Show when={row.gates > 0} fallback={<span class="text-[11px] text-muted">—</span>}>
                        <HugeIcon icon={SecurityCheckIcon} class="h-3.5 w-3.5 text-tone-amber-ink" />
                        <span class="text-[11px] tabular-nums text-ink">{row.gates}</span>
                      </Show>
                    </span>
                    <div class="flex min-w-8 flex-1 items-center gap-1.5">
                      <div class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-hairline"><div class="h-full rounded-full bg-tone-blue-ink" style={{ width: `${row.progress}%` }} /></div>
                      <span class="w-7 shrink-0 text-right text-[11px] tabular-nums text-ink-soft">{row.progress}%</span>
                    </div>
                  </div>
                </div>
              </div>
            )}</For>
          </div>
          <Show when={completedRows().length > 0}>
            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3">
              <Show when={visibleRows().length === 0}>
                <p class="text-[12px] text-muted">All initiatives are complete.</p>
              </Show>
              <button
                type="button"
                aria-expanded={showCompleted()}
                onClick={() => setShowCompleted((visible) => !visible)}
                class="rounded-[10px] px-2 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              >
                {showCompleted() ? "Show less" : `Show ${completedRows().length} completed`}
              </button>
            </div>
          </Show>
      </div>
    </PageFrame>
  );
}
