/**
 * Projects.
 *
 * **No es alcanzable hoy**: el sidebar no tiene entrada de Projects, así que nada llama a
 * `setActiveView("Projects")`. Se conserva tal cual, con `AppIcon` (el único SVG hecho a mano que queda
 * junto a los hexágonos de status) porque borrar código muerto es una decisión aparte de una extracción.
 * Cuando se borre, se van los tres juntos: esta página, `AppIcon` y su entrada del registro.
 */
import { For } from "solid-js";
import { PageFrame } from "./PageFrame";

function AppIcon(props: { name: string; class?: string }) {
  return (
    <svg class={props.class ?? "h-4 w-4 shrink-0"} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.name === "chevron" && <path d="m7 4 6 6-6 6" />}
    </svg>
  );
}

export function ProjectsPage() {
  return (
    <PageFrame>
      <section aria-label="Projects" class="space-y-3">
                        <For each={[["Website refresh", "Design · 8 tasks"], ["Product launch", "Marketing · 5 tasks"], ["Customer research", "Research · 3 tasks"]]}>{(project) => <article class="flex min-h-[78px] items-center gap-4 rounded-[12px] border border-line px-5"><span class="h-9 w-9 rounded-[10px] border border-line bg-sunken" /><div><h2 class="text-[14px] font-medium">{project[0]}</h2><p class="mt-1 text-[12px] text-muted">{project[1]}</p></div><AppIcon name="chevron" class="ml-auto h-4 w-4 text-faint" /></article>}</For>
      </section>
    </PageFrame>
  );
}
