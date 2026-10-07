import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, waitFor } from "storybook/test";
import { TaskActivityFeed } from "./TaskActivityFeed";
import type { TaskActivityFeedProps } from "./TaskActivityFeed";

/**
 * Historial de la tarea.
 *
 * Los tipos de entrada salen de las acciones reales del log de climier (`take`, `task.submit`,
 * `task.accept`, `release`, `add-note`, …). Cambiar un icono o un color se ve de inmediato.
 */
const meta = {
  title: "Tasks/TaskActivityFeed",
  component: TaskActivityFeed,
  parameters: { layout: "centered" },
  argTypes: { activity: { control: "object" }, raw: { control: "boolean" } },
} satisfies Meta<typeof TaskActivityFeed>;

export default meta;

type Story = StoryObj<TaskActivityFeedProps>;

const Column = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[560px] bg-surface p-6">{props.children}</div>
);

export const Playground: Story = {
  args: {
    activity: [
      { id: "1", kind: "created", author: "orchestrator", text: "created the task", at: "5d" },
      { id: "2", kind: "claim", author: "climier-worker", text: "claimed it", at: "3d" },
      { id: "3", kind: "comment", author: "reviewer", text: "commented", at: "2d", comment: "El error de red no dice qué hacer: agregar una acción de reintento." },
      { id: "4", kind: "submit", author: "climier-worker", text: "submitted it for validation", at: "1d" },
      { id: "5", kind: "accept", author: "climier-validator", text: "accepted it", at: "6h" },
    ],
  },
  render: (args) => <Column><TaskActivityFeed {...args} /></Column>,
};

/** Sólo el evento de creación: el mínimo de la lista. */
export const SingleEntry: Story = {
  args: { activity: [{ id: "one", kind: "created", author: "orchestrator", text: "created the task", at: "3d" }] },
  render: (args) => <Column><TaskActivityFeed {...args} /></Column>,
};

/**
 * Un comentario en markdown: la burbuja renderiza negrita, código y listas, no el texto plano.
 *
 * Se prueba desde `TaskActivityFeed` y no desde `Markdown` porque el contrato real es que la nota del
 * thread entre al render, no que el componente de markdown funcione aislado.
 */
export const MarkdownComment: Story = {
  args: {
    activity: [
      {
        id: "md",
        kind: "comment",
        author: "reviewer-ejecucion",
        text: "commented",
        at: "1d",
        comment: "The **network error** does not say what to do:\n\n- add a `retry` action\n- keep the cart",
      },
    ],
  },
  render: (args) => <Column><TaskActivityFeed {...args} /></Column>,
  play: async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="markdown"] strong')?.textContent).toBe("network error"));
    await expect(document.querySelectorAll('[data-testid="markdown"] li').length).toBe(2);
  },
};

/** Un comentario largo: la burbuja envuelve el texto sin romper el ancho de la columna. */
export const LongComment: Story = {
  args: {
    activity: [
      {
        id: "long",
        kind: "comment",
        author: "reviewer-ejecucion",
        text: "commented",
        at: "2d",
        comment: "When the payment fails halfway the customer currently loses the cart, the coupon and any address they had already confirmed. Rebuild the recovery path so every one of those survives, and make the failure explain itself without sending the customer to support.",
      },
    ],
  },
  render: (args) => <Column><TaskActivityFeed {...args} /></Column>,
};
