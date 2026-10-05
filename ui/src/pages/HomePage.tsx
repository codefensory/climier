import { createMemo } from "solid-js";
import { useProjectData } from "../modules/app-shell";
import type { ClimierSnapshot } from "../modules/tasks";
import { projectBoard } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

export function HomePage() {
  const data = useProjectData();
  const snapshot = () => data.snapshot() as ClimierSnapshot;
  const board = createMemo(() => projectBoard(snapshot()));
  const openTasks = createMemo(() => board().tasks.filter((task) => !["done", "archived", "canceled"].includes(task.status)).length);
  const completed = createMemo(() => board().tasks.filter((task) => task.status === "done" || task.status === "archived").length);
  const projectName = () => data.selectedProject()?.name ?? data.projectId() ?? "this project";

  return (
    <PageFrame>
      <div>
        <p class="mb-5 text-[14px] text-muted">A clear view of what’s moving in {projectName()}.</p>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Open tasks</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">{openTasks()}</p><p class="mt-1 text-[12px] text-faint">In this project</p></section>
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Nodes</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">{Object.keys(snapshot().nodes).length}</p><p class="mt-1 text-[12px] text-faint">Tasks and gates</p></section>
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Completed</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">{completed()}</p><p class="mt-1 text-[12px] text-faint">Accepted work</p></section>
        </div>
        <section class="mt-5 rounded-[12px] border border-line p-5"><h2 class="text-[14px] font-medium">Up next</h2><p class="mt-2 text-[13px] text-muted">Live project updates appear here as the server revision changes.</p></section>
      </div>
    </PageFrame>
  );
}
