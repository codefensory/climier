import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { StoryShell } from "../test-utils/StoryShell";
import { must } from "../test-utils/story";
import { TaskDetailPage } from "./TaskDetailPage";

/**
 * Página de detalle de una tarea.
 *
 * `TaskDetailPage` lee el id de `useParams()`, pero `StoryShell` monta una ruta `*` que no aporta
 * params. Por eso la story pasa `taskId` por prop: es la única forma de mostrar la página sin armar
 * un router paralelo con `/tasks/:id` sólo para las stories.
 */
const meta = {
  title: "Pages/TaskDetailPage",
  component: TaskDetailPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskDetailPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

const Host = (props: { taskId: string }) => (
  <StoryShell path={`/tasks/${props.taskId}`}>
    <div class="min-h-screen bg-surface">
      <TaskDetailPage taskId={props.taskId} />
    </div>
  </StoryShell>
);

export const Playground: Story = {
  render: () => <Host taskId="T-checkout-empty-states" />,
};

export const Dark: Story = {
  globals: { theme: "dark" },
  render: () => <Host taskId="T-checkout-empty-states" />,
};

/** Un id que no existe: el detalle no se monta y aparece el estado vacío. */
export const NotFound: Story = {
  render: () => <Host taskId="T-404-not-found" />,
  play: async () => {
    await waitFor(() => expect(document.body.textContent).toContain("Task not found"));
    await expect(document.body.textContent).toContain("T-404-not-found");
  },
};

/**
 * Escribir un comentario.
 *
 * El comentario se agrega al historial en memoria, así que la aserción es sobre el DOM: después de
 * enviar, el texto aparece en la sección de actividad firmado por "You". Es el camino completo del
 * compositor dentro de la página, no la story aislada del componente.
 */
export const CommentFlow: Story = {
  render: () => <Host taskId="T-checkout-empty-states" />,
  play: async () => {
    const input = must(document.querySelector<HTMLInputElement>('input[aria-label="Write a comment"]'), "el campo de comentario");
    await userEvent.type(input, "Ship it after the contrast pass.");
    const send = must(document.querySelector<HTMLButtonElement>('button[aria-label="Send comment"]'), "el botón de enviar");
    await userEvent.click(send);
    await waitFor(() => expect(document.body.textContent).toContain("Ship it after the contrast pass."));
    await expect(document.body.textContent).toContain("you");
  },
};
