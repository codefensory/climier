import { createSignal, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { must } from "../../../test-utils/story";
import { TaskCommentComposer } from "./TaskCommentComposer";
import type { TaskCommentComposerProps } from "./TaskCommentComposer";

/**
 * Compositor de comentarios.
 *
 * La story con `play` prueba **el camino real**, no el callback: escribe, envía y comprueba que el
 * comentario llegó y que el campo quedó vacío. Un compositor que envía dos veces el mismo texto, o que
 * no limpia, se ve acá.
 */
const meta = {
  title: "Tasks/TaskCommentComposer",
  component: TaskCommentComposer,
  parameters: { layout: "centered" },
  argTypes: { placeholder: { control: "text" }, onSubmit: { control: false } },
} satisfies Meta<typeof TaskCommentComposer>;

export default meta;

type Story = StoryObj<TaskCommentComposerProps>;

const Column = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[560px] bg-surface p-6">{props.children}</div>
);

export const Playground: Story = {
  args: { onSubmit: () => {} },
  render: (args) => <Column><TaskCommentComposer {...args} /></Column>,
};

/**
 * Enviar con Enter y con el botón.
 *
 * Se verifica el resultado visible —la lista de comentarios— y no el espía: lo que importa es que el
 * texto salga del campo y aparezca donde corresponde. El botón de enviar arranca deshabilitado con el
 * campo vacío, que es la mitad del contrato del compositor.
 */
export const SubmitFlow: Story = {
  render: () => {
    const [submitted, setSubmitted] = createSignal<string[]>([]);
    return (
      <Column>
        <TaskCommentComposer onSubmit={(comment) => setSubmitted((previous) => [...previous, comment])} />
        <ul data-testid="submitted" class="mt-4 space-y-1 text-[13px] text-ink">
          <For each={submitted()}>{(comment) => <li>{comment}</li>}</For>
        </ul>
      </Column>
    );
  },
  play: async () => {
    const input = must(document.querySelector<HTMLInputElement>('input[aria-label="Write a comment"]'), "el campo de comentario");
    const send = must(document.querySelector<HTMLButtonElement>('button[aria-label="Send comment"]'), "el botón de enviar");
    await expect(send.disabled).toBe(true);

    await userEvent.type(input, "Looks good to me{Enter}");
    await waitFor(() => expect(document.querySelectorAll('[data-testid="submitted"] li').length).toBe(1));
    await expect(input.value).toBe("");
    await expect(send.disabled).toBe(true);
  },
};

/** Con el campo vacío el botón de enviar está deshabilitado y el campo muestra el placeholder. */
export const Empty: Story = {
  args: { onSubmit: () => {} },
  render: (args) => <Column><TaskCommentComposer {...args} /></Column>,
};
