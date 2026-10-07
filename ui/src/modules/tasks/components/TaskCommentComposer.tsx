import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import { createSignal } from "solid-js";
import { HugeIcon } from "../../core";
import { Button } from "../../ui";

export type TaskCommentComposerProps = {
  placeholder?: string;
  onSubmit?: (comment: string) => void;
};

/**
 * Compositor de notas.
 *
 * No tiene una variante "enviando" ni estado de error porque no hay backend: la nota se entrega por
 * callback y la página decide qué hacer con ella (hoy la agrega al historial en memoria).
 *
 * El envío funciona con **Enter** (submit implícito del form) y con el botón. El botón de enviar se
 * deshabilita con el campo vacío: un control que no puede hacer nada no debería verse accionable.
 */
export function TaskCommentComposer(props: TaskCommentComposerProps) {
  const [value, setValue] = createSignal("");

  const submit = (event: Event) => {
    event.preventDefault();
    const comment = value().trim();
    if (!comment) return;
    props.onSubmit?.(comment);
    setValue("");
  };

  return (
    <form onSubmit={submit} class="flex items-center gap-1 rounded-[10px] bg-sunken py-1 pr-1.5 pl-3 transition-colors focus-within:outline-2 focus-within:outline-ink">
      <input
        type="text"
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        placeholder={props.placeholder ?? "Write a note…"}
        aria-label="Write a comment"
        class="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-ink outline-none placeholder:text-faint"
      />
      <Button variant="icon" aria-label="Send comment" disabled={value().trim().length === 0} onClick={submit} class="disabled:cursor-not-allowed disabled:opacity-40">
        <HugeIcon icon={SentIcon} class="h-4 w-4" strokeWidth="1.6" />
      </Button>
    </form>
  );
}
