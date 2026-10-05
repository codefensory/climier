import Layers01Icon from "@hugeicons/core-free-icons/Layers01Icon";
import { For } from "solid-js";
import { HugeIcon } from "../../core";
import { Button, MenuOption, PopoverSurface } from "../../ui";
import { usePopoverMenu } from "../controllers/usePopoverMenu";
import { groupFields } from "../data/sorting";
import type { TaskGroupBy } from "../types";

export type GroupMenuProps = {
  group: TaskGroupBy;
  onGroup: (group: TaskGroupBy) => void;
  /** El estado abierto/cerrado lo tiene `TasksToolbar`, para que no haya dos menús abiertos. */
  isOpen: () => boolean;
  onOpen: () => void;
  onClose: () => void;
};

const MENU_WIDTH = 180;
const MENU_HEIGHT = 152;

/**
 * Menú de agrupación.
 *
 * Es el mismo comportamiento que `SortMenu` (por eso comparten `usePopoverMenu` y `PopoverSurface`),
 * con dos diferencias: es más chico y no tiene la sección de dirección, porque agrupar no tiene
 * sentido inverso.
 *
 * Elegir un grupo cierra el menú y **no** cierra el panel de filtros: agrupar y filtrar son ejes
 * independientes, así que se pueden combinar.
 */
export function GroupMenu(props: GroupMenuProps) {
  const menu = usePopoverMenu({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    menuSelector: '[data-testid="task-group-menu"]',
    triggerSelector: "[data-group-trigger]",
    isOpen: props.isOpen,
    setOpen: (open) => (open ? props.onOpen() : props.onClose()),
  });

  const select = (group: TaskGroupBy) => {
    props.onGroup(group);
    menu.close(true);
  };

  return (
    <>
      <Button variant="ghost" state={props.isOpen() ? "open" : props.group !== "status" ? "applied" : "idle"} data-group-trigger="" aria-label="Group" aria-haspopup="menu" aria-expanded={props.isOpen()} aria-controls="task-group-menu" onClick={menu.toggle}>
        <HugeIcon icon={Layers01Icon} class="h-4 w-4 shrink-0" /><span class="hidden min-[900px]:inline">Group</span>
      </Button>
      <PopoverSurface variant="menuNarrow" open={props.isOpen()} left={menu.position().left} top={menu.position().top} role="listbox" label="Group by" id="task-group-menu" testId="task-group-menu">
        <For each={groupFields}>{(option) => <MenuOption selected={props.group === option.key} onSelect={() => select(option.key)} leading={<span class="flex h-5 w-5 shrink-0 items-center justify-center"><HugeIcon icon={option.icon} class="h-3.5 w-3.5" /></span>} label={<span>{option.label}</span>} />}</For>
      </PopoverSurface>
    </>
  );
}
