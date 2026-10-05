import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { createMemo, createSignal, Show } from "solid-js";
import { HugeIcon } from "../modules/core";
import { isGateDetailPath } from "../modules/app-shell";
import { localAuthor, projectGateRegistry, snapshot, TaskDetailView, TaskNotFound, taskDetailById } from "../modules/tasks";
import type { TaskActivityEntry } from "../modules/tasks";
import { PageFrame } from "./PageFrame";

export type TaskDetailPageProps = {
  /**
   * Id explícito.
   *
   * La ruta real lo toma de `useParams()`. La prop existe para las stories: `StoryShell` monta una
   * ruta `*`, que no aporta params, así que sin esto la story no podría mostrar un detalle sin armar
   * su propio router con `/tasks/:id`.
   */
  taskId?: string;
};

/**
 * Página de detalle de una tarea.
 *
 * Resuelve el id contra el snapshot (`taskDetailById`) y arma el `TaskDetail`, que es lo único que
 * la vista necesita. El comentario que se escribe se agrega al historial **en memoria**: no hay
 * backend de escritura, pero la interacción se completa para que la página no sea una maqueta muerta.
 */
export function TaskDetailPage(props: TaskDetailPageProps = {}) {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const registry = createMemo(() => projectGateRegistry(snapshot));
  const gateContext = () => isGateDetailPath(location.pathname);
  const gateForId = () => registry().find((gate) => gate.id === (props.taskId ?? params.id ?? ""));
  const gateInfo = {
    get record() { return gateForId()!; },
    get resolutionMode() {
      const gate = gateForId();
      return gate ? snapshot.nodes[gate.id]?.resolution_mode ?? "" : "";
    },
  };
  const [comments, setComments] = createSignal<TaskActivityEntry[]>([]);

  const id = () => props.taskId ?? params.id ?? "";

  const detail = () => {
    if (gateContext() && !gateForId()) return null;
    const base = taskDetailById(id());
    if (!base) return null;
    return { ...base, activity: [...base.activity, ...comments()] };
  };

  const addComment = (comment: string) => {
    setComments((previous) => [
      ...previous,
      { id: `local-comment-${previous.length}`, kind: "comment", author: localAuthor, text: "commented", at: "now", comment },
    ]);
  };

  const backToList = () => navigate(gateContext() ? `/gates${location.search}` : "/tasks");
  const openNode = (nodeId: string, kind: "task" | "gate") => {
    navigate(`/${kind === "gate" ? "gates" : "tasks"}/${encodeURIComponent(nodeId)}`);
    document.querySelector<HTMLElement>(".main-content-view")?.scrollTo(0, 0);
  };

  return (
    <PageFrame header={<button type="button" onClick={backToList} class="inline-flex items-center gap-1 rounded-[6px] text-[13px] leading-5 text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"><HugeIcon icon={ArrowLeft01Icon} class="h-4 w-4" strokeWidth="1.8" />{gateContext() ? "Gates" : "Tasks"}</button>}>
      <div class="task-detail-content">
        <Show when={detail()} fallback={<TaskNotFound id={id()} entity={gateContext() ? "gate" : undefined} backLabel={gateContext() ? "Gates" : undefined} onBack={gateContext() ? backToList : undefined} />}>
          {(value) => <TaskDetailView detail={value()} gateInfo={gateContext() ? gateInfo : undefined} onOpenNode={openNode} onSubmitComment={addComment} />}
        </Show>
      </div>
    </PageFrame>
  );
}
