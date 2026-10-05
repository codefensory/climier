import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { makeTaskDetail } from "../data/fixtures";
import { TaskDetailView } from "./TaskDetailView";
import type { TaskDetailViewProps } from "./TaskDetailView";

/**
 * Vista de detalle completa.
 *
 * Se monta dentro del padding real del frame para que la story mida lo mismo que la página: el ancho
 * cómodo de lectura y el corte a dos columnas en `md` dependen de ese contenedor.
 */
const meta = {
  title: "Tasks/TaskDetailView",
  component: TaskDetailView,
  parameters: { layout: "fullscreen" },
  argTypes: { detail: { control: "object" }, onBack: { control: false }, onSubmitComment: { control: false } },
} satisfies Meta<typeof TaskDetailView>;

export default meta;

type Story = StoryObj<TaskDetailViewProps>;

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="min-h-screen bg-white px-6 py-7 sm:px-8 lg:px-10">{props.children}</div>
);

const richDetail = () => makeTaskDetail({
  body: [
    "Map the empty, error and recovery moments across checkout as one flow instead of three disconnected screens.",
    "Keep every surface inside the current token set and make the failure explain itself without sending the customer to support.",
  ],
  acceptance: "Empty, error and recovery states reviewed at 639, 1023 and 1440.",
  blockers: [{ id: "G-checkout-tax-decision", title: "Decide the tax display rule", kind: "gate", status: "open", satisfied: false }],
  dependents: [{ id: "T-checkout-recovery-flow", title: "Rebuild the recovery path", kind: "task", status: "submitted", edgeType: "BLOCKS" }],
  knowledge: [{ id: "K-checkout-empty-states", title: "Los estados vacíos se revisan contra el build", body: "Cualquier decisión de copy o layout en checkout tiene que sostenerse a 639, 1023 y 1440.", knowledgeType: "warning", status: "active", scopeMatches: ["tag"] }],
  refs: [{ id: "docs/checkout.md::explicit", name: "checkout.md", source: "explicit", kind: "doc" }],
  activity: [
    { id: "1", kind: "created", author: "orchestrator", text: "created the task", at: "5d" },
    { id: "2", kind: "claim", author: "climier-worker", text: "claimed it", at: "3d" },
    { id: "3", kind: "comment", author: "reviewer", text: "commented", at: "2d", comment: "El error de red no dice qué hacer: agregar una acción de reintento." },
    { id: "4", kind: "submit", author: "climier-worker", text: "submitted it for validation", at: "1d" },
  ],
  notes: [{ id: "n1", agent: "reviewer", text: "El error de red no dice qué hacer.", at: "2026-10-01T10:00:00.000Z" }],
}, { tags: ["design", "checkout"], status: "in_progress", progress: 50, claimedBy: "climier-worker" });

export const Playground: Story = {
  args: { detail: richDetail() },
  render: (args) => <Frame><TaskDetailView {...args} /></Frame>,
};

/** Sin actividad en el historial: la sección queda vacía pero presente. */
export const NoActivity: Story = {
  args: { detail: makeTaskDetail({ activity: [] }, { tags: ["billing"], status: "submitted", progress: 85 }) },
  render: (args) => <Frame><TaskDetailView {...args} /></Frame>,
};

/** Caso extremo: título largo, sin tags, sin refs y sin claim. */
export const Sparse: Story = {
  args: {
    detail: makeTaskDetail(
      { refs: [], blockers: [], dependents: [], knowledge: [] },
      { id: "T-sparse-900", tags: [], title: "Rework the checkout recovery flow so partially failed payments keep the original cart and the applied coupon", status: "backlog" },
    ),
  },
  render: (args) => <Frame><TaskDetailView {...args} /></Frame>,
};
