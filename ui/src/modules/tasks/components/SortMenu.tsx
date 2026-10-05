import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import Sorting01Icon from "@hugeicons/core-free-icons/Sorting01Icon";
import { For } from "solid-js";
import { HugeIcon } from "../../core";
import { Button, MenuOption, PopoverSurface } from "../../ui";
import { usePopoverMenu } from "../controllers/usePopoverMenu";
import { sortFields } from "../data/sorting";
import type { TaskSort, TaskSortKey } from "../types";

export type SortMenuProps = {
  sort: TaskSort;
  onSort: (sort: TaskSort) => void;
  /** El estado abierto/cerrado lo tiene `TasksToolbar`, para que no haya dos menús abiertos. */
  isOpen: () => boolean;
  onOpen: () => void;
  onClose: () => void;
};

/** Alto y ancho estimados del menú, para decidir si abre arriba y para clampár en horizontal. */
const MENU_WIDTH = 220;
const MENU_HEIGHT = 216;

/**
 * Menú de orden: los 4 criterios y después la dirección.
 *
 * Elegir un criterio **impone** la dirección (`title` y `status` ascendente, el resto descendente) en
 * vez de conservar la que estaba: heredar la dirección anterior daría un resultado que el usuario no
 * pidió.
 *
 * El trigger se pinta en `text-ink` cuando el orden no es el por defecto (`updated` desc), así que el
 * botón avisa que hay algo aplicado sin necesidad de abrir el menú.
 */
export function SortMenu(props: SortMenuProps) {
  const menu = usePopoverMenu({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    menuSelector: '[data-testid="task-sort-menu"]',
    triggerSelector: "[data-sort-trigger]",
    isOpen: props.isOpen,
    setOpen: (open) => (open ? props.onOpen() : props.onClose()),
  });

  const selectKey = (key: TaskSortKey) => {
    props.onSort({ key, dir: key === "title" || key === "status" ? "asc" : "desc" });
    menu.close(true);
  };
  const selectDirection = (dir: "asc" | "desc") => {
    props.onSort({ ...props.sort, dir });
    menu.close(true);
  };

  return (
    <>
      <Button variant="ghost" state={props.isOpen() ? "open" : props.sort.key !== "updated" || props.sort.dir !== "desc" ? "applied" : "idle"} data-sort-trigger="" aria-label="Sort" aria-haspopup="menu" aria-expanded={props.isOpen()} aria-controls="task-sort-menu" onClick={menu.toggle}>
        <HugeIcon icon={Sorting01Icon} class="h-4 w-4 shrink-0" /><span class="hidden min-[900px]:inline">Sort</span>
      </Button>
      <PopoverSurface variant="menuWide" open={props.isOpen()} left={menu.position().left} top={menu.position().top} role="listbox" label="Sort by" id="task-sort-menu" testId="task-sort-menu">
        <For each={sortFields}>{(option) => <MenuOption selected={props.sort.key === option.key} onSelect={() => selectKey(option.key)} leading={<span class="flex h-5 w-5 shrink-0 items-center justify-center"><HugeIcon icon={option.icon} class="h-3.5 w-3.5" /></span>} label={<span>{option.label}</span>} />}</For>
        <div class="my-1 border-t border-hairline" />
        <For each={[{ dir: "asc" as const, label: "Ascending", icon: ArrowUp01Icon }, { dir: "desc" as const, label: "Descending", icon: ArrowDown01Icon }]}>{(option) => <MenuOption selected={props.sort.dir === option.dir} onSelect={() => selectDirection(option.dir)} leading={<span class="flex h-5 w-5 shrink-0 items-center justify-center"><HugeIcon icon={option.icon} class="h-3.5 w-3.5" /></span>} label={<span>{option.label}</span>} />}</For>
      </PopoverSurface>
    </>
  );
}
