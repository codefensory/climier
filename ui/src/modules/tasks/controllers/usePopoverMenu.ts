import { createSignal, onCleanup, onMount } from "solid-js";
import { menuCoordinates } from "../utils/menuCoordinates";

export type UsePopoverMenuOptions = {
  /** Ancho estimado, para el clamp horizontal. */
  width: number;
  /** Alto estimado, para decidir si abre arriba o abajo. */
  height: number;
  /** Selector del menú portaleado: un `pointerdown` afuera lo cierra. */
  menuSelector: string;
  /** Selector del trigger: un `pointerdown` acá **no** lo cierra, porque el `onClick` lo togglea. */
  triggerSelector: string;
  /** El estado abierto/cerrado lo tiene el padre: es el que garantiza que no haya dos abiertos. */
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
};

/**
 * Mecánica de un menú flotante anclado a un trigger: posición, trigger y descarte.
 *
 * **No** es dueño del estado abierto/cerrado a propósito. Ese estado lo tiene `TasksToolbar` en un
 * solo signal, porque la regla real es "como máximo un menú abierto" y eso no se puede sostener con
 * un booleano por menú sin coordinación explícita.
 *
 * El de sort y el de group son el mismo comportamiento con distinto contenido y tamaño, así que la
 * mecánica vive acá una sola vez: antes eran dos bloques de estado paralelos y dos ramas idénticas
 * en cada listener.
 */
export function usePopoverMenu(options: UsePopoverMenuOptions) {
  const [position, setPosition] = createSignal({ left: 0, top: 0 });

  // El trigger vive en una variable y no en un signal: sólo se lee dentro de eventos, nunca durante
  // el render, así que hacerlo reactivo no aporta nada.
  let trigger: HTMLButtonElement | undefined;

  const place = () => {
    if (trigger) setPosition(menuCoordinates(trigger, options.width, options.height));
  };

  const close = (restoreFocus = false) => {
    options.setOpen(false);
    if (restoreFocus) trigger?.focus();
  };

  /** Ya abierto → cierra sin devolver el foco: el foco se fue con el click del usuario. */
  const toggle = (event: MouseEvent) => {
    if (options.isOpen()) {
      close();
      return;
    }
    trigger = event.currentTarget as HTMLButtonElement;
    options.setOpen(true);
    place();
  };

  onMount(() => {
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (options.isOpen() && !target.closest(options.menuSelector) && !target.closest(options.triggerSelector)) close();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && options.isOpen()) close(true);
    };
    const reposition = () => {
      if (options.isOpen()) place();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", reposition);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", reposition);
    });
  });

  return { position, toggle, close };
}
