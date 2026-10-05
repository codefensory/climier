import { Show } from "solid-js";
import { useProjectData } from "../modules/app-shell";

export function ProjectStatePage() {
  const data = useProjectData();
  return (
    <main data-testid="project-state" class="flex min-h-[calc(100vh-44px)] items-center justify-center bg-white px-6 py-12 text-center">
      <section class="max-w-[420px]">
        <Show when={data.projectStatus() === "loading"}><h1 class="text-[20px] font-semibold">Loading projects…</h1><p class="mt-2 text-[13px] text-muted">Connecting to the Climier server.</p></Show>
        <Show when={data.projectStatus() === "empty"}><h1 class="text-[20px] font-semibold">No projects available</h1><p class="mt-2 text-[13px] text-muted">Provision a project on the server, then retry.</p><RetryButton onRetry={data.retry} /></Show>
        <Show when={data.projectStatus() === "unknown"}><h1 class="text-[20px] font-semibold">Project not found</h1><p class="mt-2 text-[13px] text-muted">The project in the URL is not in the catalog. Choose another project or retry.</p><RetryButton onRetry={data.retry} /></Show>
        <Show when={data.projectStatus() === "uninitialized"}><h1 class="text-[20px] font-semibold">Project state is not initialized</h1><p class="mt-2 text-[13px] text-muted">Initialize this project on the server before opening it.</p><RetryButton onRetry={data.retry} /></Show>
        <Show when={data.projectStatus() === "error"}><h1 class="text-[20px] font-semibold">Unable to load project</h1><p class="mt-2 text-[13px] text-muted">{data.errorMessage() ?? "The server could not provide this project."}</p><RetryButton onRetry={data.retry} /></Show>
      </section>
    </main>
  );
}

function RetryButton(props: { onRetry: () => void }) {
  return <button type="button" onClick={props.onRetry} class="mt-5 rounded-[9px] bg-ink px-4 py-2 text-[13px] font-medium text-white">Retry</button>;
}
