import { Show } from "solid-js";
import { Button } from "../../ui";
import { SidebarControlIcon } from "./SidebarControlIcon";

export type ShowSidebarButtonProps = {
  visible: () => boolean;
  onShow: () => void;
};

/**
 * Botón que reaparece cuando el sidebar está oculto.
 *
 * `visible` es un accessor y no un booleano porque quien lo usa lo deriva de estado reactivo;
 * el componente decide el `<Show>` y no el consumidor.
 */
export function ShowSidebarButton(props: ShowSidebarButtonProps) {
  return (
    <Show when={props.visible()}>
      <Button variant="icon" data-testid="app-sidebar-show" aria-label="Show sidebar" onClick={props.onShow}>
        <SidebarControlIcon />
      </Button>
    </Show>
  );
}
