import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { gateGroup, taskGroups } from "../utils/taskGroups";
import { GroupHeader } from "./GroupHeader";
import { TaskListRow } from "./TaskListRow";
import type { Task, TaskGroupBy, TaskSort } from "../types";

export type TaskListViewProps = {
  tasks: Task[];
  /** Gates abiertas, en su propia sección arriba de las columnas de tarea. */
  gates?: Task[];
  sort: TaskSort;
  group: TaskGroupBy;
  /** Abre una tarea. Se pasa a cada fila; sin esto la lista es sólo informativa. */
  onOpenTask?: (task: Task) => void;
};

const INITIAL_ROWS = 50;
const APPEND_ROWS = 25;

function TaskRows(props: { tasks: Task[]; onOpenTask?: (task: Task) => void }) {
  return <div class="divide-y divide-hairline"><For each={props.tasks}>{(task) => <TaskListRow task={task} onOpen={props.onOpenTask} />}</For></div>;
}

/** Vista de lista normal con carga progresiva para conjuntos que superan el primer bloque. */
export function TaskListView(props: TaskListViewProps) {
  const gates = () => props.gates ?? [];
  const groups = createMemo(() => taskGroups(props.tasks, props.group, props.sort).filter((group) => group.tasks.length > 0));
  const totalRows = createMemo(() => groups().reduce((total, group) => total + group.tasks.length, 0));
  const [loadedRows, setLoadedRows] = createSignal(INITIAL_ROWS);
  const hasMoreRows = () => loadedRows() < totalRows();
  const renderedGroupCounts = createMemo(() => {
    let remaining = loadedRows();
    return groups().map((group) => {
      const count = Math.min(group.tasks.length, remaining);
      remaining -= count;
      return count;
    });
  });
  let list: HTMLDivElement | undefined;
  let scrollRoot: HTMLElement | null = null;
  let appendFrame: number | undefined;
  let checkFrame: number | undefined;
  let appending = false;
  let readerHasScrolled = false;
  let keepBottomPinned = false;
  let previousScrollTop = 0;
  const scrollPosition = () => ({
    top: scrollRoot?.scrollTop ?? window.scrollY,
    height: scrollRoot?.clientHeight ?? window.innerHeight,
    contentHeight: scrollRoot?.scrollHeight ?? document.documentElement.scrollHeight,
  });
  const distanceToBottom = () => {
    const position = scrollPosition();
    return position.contentHeight - position.height - position.top;
  };
  const isAtBottom = () => distanceToBottom() <= 2;
  const isNearBottom = () => distanceToBottom() <= scrollPosition().height;
  const scrollToBottom = () => {
    if (scrollRoot) scrollRoot.scrollTop = scrollRoot.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
    previousScrollTop = scrollPosition().top;
  };
  let appendNextBlock = () => {};
  // Content-visibility can move the estimated bottom while rows are being learned; once pinned,
  // keep loading from that intent instead of requiring every new bottom to stay near the viewport.
  const scheduleAppendCheck = () => {
    if (!readerHasScrolled || !hasMoreRows() || appending || checkFrame !== undefined) return;
    checkFrame = requestAnimationFrame(() => {
      checkFrame = undefined;
      if (readerHasScrolled && hasMoreRows() && (keepBottomPinned || isNearBottom())) appendNextBlock();
    });
  };
  appendNextBlock = () => {
    if (appending || !readerHasScrolled || (!keepBottomPinned && !isNearBottom())) return;
    const remaining = Math.min(APPEND_ROWS, totalRows() - loadedRows());
    if (remaining <= 0) return;
    appending = true;
    keepBottomPinned = isAtBottom() || keepBottomPinned;
    const firstHalf = Math.ceil(remaining / 2);
    setLoadedRows((current) => Math.min(current + firstHalf, totalRows()));
    const secondHalf = remaining - firstHalf;
    const finishAppend = () => {
      appendFrame = undefined;
      if (secondHalf > 0) setLoadedRows((current) => Math.min(current + secondHalf, totalRows()));
      if (keepBottomPinned) scrollToBottom();
      appending = false;
      if (!hasMoreRows()) keepBottomPinned = false;
      scheduleAppendCheck();
    };
    if (secondHalf > 0) appendFrame = requestAnimationFrame(finishAppend);
    else finishAppend();
  };

  createEffect(on(
    [() => props.tasks, () => props.group, () => props.sort.key, () => props.sort.dir],
    () => {
      if (appendFrame !== undefined) cancelAnimationFrame(appendFrame);
      if (checkFrame !== undefined) cancelAnimationFrame(checkFrame);
      appendFrame = undefined;
      checkFrame = undefined;
      appending = false;
      readerHasScrolled = false;
      keepBottomPinned = false;
      previousScrollTop = scrollPosition().top;
      setLoadedRows(INITIAL_ROWS);
    },
    { defer: true },
  ));

  onMount(() => {
    scrollRoot = list?.closest<HTMLElement>(".main-content-view") ?? null;
    previousScrollTop = scrollPosition().top;
    const trackScroll = () => {
      readerHasScrolled = true;
      const top = scrollPosition().top;
      const movingUp = top < previousScrollTop;
      previousScrollTop = top;
      if (keepBottomPinned && movingUp) keepBottomPinned = false;
      else if (appending && !keepBottomPinned && isAtBottom()) keepBottomPinned = true;
      scheduleAppendCheck();
    };
    if (scrollRoot) scrollRoot.addEventListener("scroll", trackScroll, { passive: true });
    else window.addEventListener("scroll", trackScroll, { passive: true });
    onCleanup(() => {
      if (scrollRoot) scrollRoot.removeEventListener("scroll", trackScroll);
      else window.removeEventListener("scroll", trackScroll);
      if (appendFrame !== undefined) cancelAnimationFrame(appendFrame);
      if (checkFrame !== undefined) cancelAnimationFrame(checkFrame);
    });
  });

  return (
    <div ref={list} data-testid="tasks-list-view" class="flex flex-col gap-6">
      <Show when={gates().length > 0}>
        <section data-testid="tasks-gates">
          <GroupHeader group={gateGroup(gates())} sticky />
          <TaskRows tasks={gates()} onOpenTask={props.onOpenTask} />
        </section>
      </Show>
      <For each={groups()}>{(group, index) => (
        <section data-testid="tasks-group" data-status={group.status} data-group={group.key}>
          <Show when={props.group !== "none"}><GroupHeader group={group} sticky /></Show>
          <TaskRows tasks={group.tasks.slice(0, renderedGroupCounts()[index()])} onOpenTask={props.onOpenTask} />
        </section>
      )}</For>
    </div>
  );
}
