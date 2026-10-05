import File02Icon from "@hugeicons/core-free-icons/File02Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import { For, Show } from "solid-js";
import { HugeIcon } from "../../core";
import type { HugeIconAsset } from "../../core";
import type { TaskReference, TaskReferenceKind } from "../types";

export type TaskReferenceListProps = {
  references: TaskReference[];
};

const REFERENCE_ICON: Record<TaskReferenceKind, HugeIconAsset> = {
  doc: File02Icon,
  link: Link01Icon,
  file: File02Icon,
};

/**
 * Referencias del node: `refs` explícitas más los documentos detectados en `body`, `acceptance` y
 * notas. Cada una dice de dónde salió (`explicit`, `body`, `acceptance`, `notes`), que es la
 * distinción que pide el modelo: una referencia declarada no es lo mismo que un path mencionado.
 *
 * La sección se muestra siempre, incluso vacía, porque su lugar en la página es estable.
 */
export function TaskReferenceList(props: TaskReferenceListProps) {
  return (
    <section aria-label="References">
      <h2 class="text-[12px] leading-4 font-medium text-muted">References</h2>
      <Show when={props.references.length > 0} fallback={<p class="mt-3 text-[12px] leading-4 text-faint">No references yet.</p>}>
        <ul class="mt-3 flex flex-col gap-2">
          <For each={props.references}>{(reference) => (
            <li class="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2">
              <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-sunken text-muted">
                <HugeIcon icon={REFERENCE_ICON[reference.kind]} class="h-4 w-4" strokeWidth="1.6" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] leading-5 text-ink">{reference.name}</span>
                <span class="block text-[11px] leading-4 text-faint">{reference.source}</span>
              </span>
            </li>
          )}</For>
        </ul>
      </Show>
    </section>
  );
}
