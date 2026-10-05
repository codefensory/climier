import KanbanIcon from "@hugeicons/core-free-icons/KanbanIcon";
import ListViewIcon from "@hugeicons/core-free-icons/ListViewIcon";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";
import type { TaskView } from "../types";

export type TasksViewSwitchProps = {
  view: TaskView;
  onView: (view: TaskView) => void;
};

/**
 * Switch lista/kanban.
 *
 * Es `aria-pressed` y no `role="tablist"`: no hay paneles asociados, sólo un botón que cambia de
 * estado. Los dos botones comparten la píldora de fondo y el activo se pinta blanco con una sombra
 * de 1px, así que la posición del indicador no se anima — se mueve por CSS de estado.
 *
 * En pantallas angostas se acorta el padding (`px-2` en vez de `sm:px-2.5`) porque el switch
 * comparte la fila con los tres botones de la derecha.
 *
 * Los dos botones son `Button variant="segment"`: es la única receta del proyecto con un estado
 * `active` (fondo blanco más una sombra de 1px), y vive en la tabla de variantes de `ui`.
 */
export function TasksViewSwitch(props: TasksViewSwitchProps) {
  return (
    <div data-testid="tasks-view-switch" class="flex shrink-0 items-center gap-[3px] rounded-[10px] bg-subtle p-[3px]">
      <Button variant="segment" state={props.view === "list" ? "active" : "idle"} aria-pressed={props.view === "list"} onClick={() => props.onView("list")}>
        <HugeIcon icon={ListViewIcon} class="h-4 w-4" />List
      </Button>
      <Button variant="segment" state={props.view === "kanban" ? "active" : "idle"} aria-pressed={props.view === "kanban"} onClick={() => props.onView("kanban")}>
        <HugeIcon icon={KanbanIcon} class="h-4 w-4" />Kanban
      </Button>
    </div>
  );
}
