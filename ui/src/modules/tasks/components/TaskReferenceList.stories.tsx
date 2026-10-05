import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TaskReferenceList } from "./TaskReferenceList";
import type { TaskReferenceListProps } from "./TaskReferenceList";

/**
 * Referencias del node: `refs` explícitas más los documentos detectados en `body`, `acceptance` y
 * notas. Cada una dice de dónde salió, que es la distinción del modelo.
 */
const meta = {
  title: "Tasks/TaskReferenceList",
  component: TaskReferenceList,
  parameters: { layout: "centered" },
  argTypes: { references: { control: "object" } },
} satisfies Meta<typeof TaskReferenceList>;

export default meta;

type Story = StoryObj<TaskReferenceListProps>;

const Rail = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="w-[240px] bg-white p-6">{props.children}</div>
);

export const Playground: Story = {
  args: {
    references: [
      { id: "1", name: "checkout.md", source: "explicit", kind: "doc" },
      { id: "2", name: "004-session-refresh.md", source: "body", kind: "doc" },
      { id: "3", name: "https://climier.dev", source: "explicit", kind: "link" },
    ],
  },
  render: (args) => <Rail><TaskReferenceList {...args} /></Rail>,
};

/** Sin referencias: la sección queda presente con su texto vacío. */
export const Empty: Story = {
  args: { references: [] },
  render: (args) => <Rail><TaskReferenceList {...args} /></Rail>,
};
