import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { makeGate, makeTask, makeTaskDetail } from "../data/fixtures";
import { gatePurposeLabel } from "../data/gatePurposes";
import { statusLabel } from "../data/statuses";
import { GateRow } from "./GateRow";
import { GateEgoPanel } from "./GateEgoPanel";
import { TaskDetailView } from "./TaskDetailView";
import { projectGateRegistry } from "../data/gates";
import type { GateRecord, GateRelation } from "../data/gates";
import { snapshot } from "../data/source";
import type { GateEgoPanelProps } from "./GateEgoPanel";
import type { Task, TaskStatus } from "../types";

const meta = {
  title: "Tasks/GateEgoPanel",
  component: GateEgoPanel,
  parameters: { layout: "fullscreen" },
  argTypes: { gate: { control: "object" }, detailHref: { control: false }, onOpen: { control: false } },
} satisfies Meta<typeof GateEgoPanel>;

export default meta;

type Story = StoryObj<GateEgoPanelProps>;

const checkoutTaxFixtureGate = () => projectGateRegistry(snapshot).find((gate) => gate.id === "G-checkout-tax-rfc")!;

const MIXED_STATUSES: TaskStatus[] = [
  "blocked", "ready", "done", "in_progress", "submitted", "blocked", "ready", "done", "canceled", "blocked",
  "ready", "in_progress", "done", "submitted", "ready", "blocked", "done", "in_progress", "ready", "canceled",
  "done", "blocked", "ready", "submitted", "done", "blocked", "in_progress", "ready", "done", "blocked",
];

function fanOutTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, index) => {
    const status = MIXED_STATUSES[index % MIXED_STATUSES.length];
    return makeTask({
      id: `T-platform-fanout-${String(index + 1).padStart(3, "0")}`,
      title: `Review downstream platform work item ${index + 1}`,
      status,
      initiative: "platform",
      domain: "platform",
      updatedAt: new Date(Date.UTC(2026, 9, 5, 12, 0, 0) - index * 60_000).toISOString(),
      progress: status === "done" ? 100 : status === "in_progress" ? 50 : status === "submitted" ? 85 : 0,
    });
  });
}

function asRelation(task: Task, edgeType: GateRelation["edgeType"] = "BLOCKS"): GateRelation {
  return { ...task, edgeType };
}

function makeFanOutGate(count: number, downstreamGateCount = 2): GateRecord {
  const task = makeGate({
    id: "G-platform-session-rfc",
    title: "RFC: Session renewal across platform surfaces",
    status: "resolved",
    purpose: "research",
    initiative: "platform",
    description: "Compare refresh strategies for authenticated work across the shared platform.",
    revision: 4,
    progress: 100,
  });
  const downstreamGates = [
    asRelation(makeGate({ id: "G-platform-session-adr", title: "ADR-002: Renew sessions without a full reload", status: "resolved", purpose: "decision", initiative: "platform" })),
    asRelation(makeGate({ id: "G-platform-offline-boundary", title: "Set the offline queue conflict boundary", status: "open", purpose: "decision", initiative: "platform" })),
  ].slice(0, downstreamGateCount);
  const impactedTasks = fanOutTasks(count).map((item) => asRelation(item));
  return {
    task,
    id: task.id,
    title: task.title,
    status: task.status,
    statusLabel: statusLabel(task.status),
    purpose: task.purpose ?? "research",
    purposeLabel: gatePurposeLabel(task.purpose ?? "research"),
    initiative: task.initiative,
    context: "Compare refresh strategies for authenticated work across the shared platform.",
    choice: "Use a silent refresh before expiry",
    rationale: "A single renewal path avoids hard reloads across shared surfaces.",
    blockedBy: [],
    unblocks: downstreamGates,
    downstreamGates,
    supersedeChain: [],
    impactedTasks,
    impactTasks: impactedTasks.length,
    impactGates: downstreamGates.length,
    totalImpact: impactedTasks.length + downstreamGates.length,
  };
}

function makeStatusCountGate(statuses: TaskStatus[]): GateRecord {
  const gate = makeFanOutGate(0, 0);
  const impactedTasks = statuses.map((status, index) => asRelation(makeTask({
    id: `T-status-counter-${index + 1}`,
    title: `Downstream status example ${index + 1}`,
    status,
  })));
  return { ...gate, impactedTasks, impactTasks: impactedTasks.length, totalImpact: impactedTasks.length };
}

function fanOutDetail(gate: GateRecord) {
  const blockers = gate.blockedBy.map((node) => ({ id: node.id, title: node.title, kind: node.kind, status: node.status, satisfied: node.status === "resolved" }));
  const dependents = [...gate.downstreamGates, ...gate.impactedTasks].map((node) => ({ id: node.id, title: node.title, kind: node.kind, status: node.status, edgeType: node.edgeType ?? "BLOCKS" as const }));
  return makeTaskDetail({
    task: gate.task,
    body: [gate.context, "Keep the session state intact while credentials renew across shared surfaces."],
    initiative: gate.initiative,
    blockers,
    dependents,
    refs: [{ id: "docs/session-refresh.md::explicit", name: "session-refresh.md", source: "explicit", kind: "doc" }],
    notes: [{ id: "fanout-note", agent: "platform-reviewer", text: "Check recovery behavior after the refresh token expires.", at: "2026-10-05T10:00:00.000Z" }],
    activity: [{ id: "fanout-created", kind: "created", author: "orchestrator", text: "created the gate", at: "1d" }],
  }, {
    id: gate.id,
    kind: "gate",
    title: gate.title,
    status: gate.status,
    purpose: gate.purpose,
    initiative: gate.initiative,
    tags: ["platform", "auth"],
    revision: gate.task.revision,
  });
}

const PanelFrame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="flex min-h-screen items-start justify-center bg-canvas p-6">
    <div class="h-[754px] w-[380px] overflow-hidden rounded-[10px] border border-line bg-white">{props.children}</div>
  </div>
);

const DetailFrame = (props: { children: import("solid-js").JSX.Element }) => (
  <div class="min-h-screen bg-white px-6 py-7 sm:px-8 lg:px-10">{props.children}</div>
);

function AccessibleGateRow(props: { gate: GateRecord }) {
  return (
    <div role="listbox" aria-label="Gates">
      <div role="group" aria-label={props.gate.initiative ?? "No initiative"}>
        <GateRow gate={props.gate} selected={false} onSelect={() => undefined} />
      </div>
    </div>
  );
}

export const FanOut30: Story = {
  args: { gate: makeFanOutGate(30) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(30);
    return (
      <div class="min-h-screen bg-canvas p-6">
        <div class="mx-auto flex max-w-[760px] flex-col gap-6">
          <div class="overflow-hidden rounded-[10px] border border-line bg-white [&_[data-testid=gate-row]>div:last-child]:w-max">
            <AccessibleGateRow gate={gate} />
          </div>
          <div class="h-[754px] w-[380px] overflow-hidden rounded-[10px] border border-line bg-white">
            <GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} />
          </div>
        </div>
      </div>
    );
  },
};

/** Small fan-out with one downstream gate, matching the existing registry detail. */
export const FourTaskOneGate: Story = {
  args: { gate: makeFanOutGate(4, 1) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(4, 1);
    return <PanelFrame><GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} /></PanelFrame>;
  },
};

/** Four fixture status counters pack on one row. */
export const FourStatusCounters: Story = {
  args: { gate: checkoutTaxFixtureGate() },
  render: (args) => {
    const gate = args.gate ?? checkoutTaxFixtureGate();
    return <PanelFrame><GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} /></PanelFrame>;
  },
};

/** Five distinct status counters balance across rows without an orphan. */
export const FiveStatusCounters: Story = {
  args: { gate: makeStatusCountGate(["blocked", "ready", "done", "in_progress", "submitted"]) },
  render: (args) => {
    const gate = args.gate ?? makeStatusCountGate(["blocked", "ready", "done", "in_progress", "submitted"]);
    return <PanelFrame><GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} /></PanelFrame>;
  },
};

/** Six distinct status counters balance across two rows without an orphan. */
export const SixStatusCounters: Story = {
  args: { gate: makeStatusCountGate(["blocked", "ready", "done", "in_progress", "submitted", "canceled"]) },
  render: (args) => {
    const gate = args.gate ?? makeStatusCountGate(["blocked", "ready", "done", "in_progress", "submitted", "canceled"]);
    return <PanelFrame><GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} /></PanelFrame>;
  },
};

/** Four-task row without a second impact figure. */
export const FourTaskNoDownstreamGate: Story = {
  args: { gate: makeFanOutGate(4, 0) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(4, 0);
    return <div class="mx-auto max-w-[760px] p-6"><div class="overflow-hidden rounded-[10px] border border-line bg-white [&_[data-testid=gate-row]>div:last-child]:w-max"><AccessibleGateRow gate={gate} /></div></div>;
  },
};

/** Same 30 mixed-status tasks, grouped on the full gate detail page. */
export const GateDetailFanOut30: Story = {
  args: { gate: makeFanOutGate(30) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(30);
    return <DetailFrame><TaskDetailView detail={fanOutDetail(gate)} gateInfo={{ record: gate, resolutionMode: "choice" }} /></DetailFrame>;
  },
};

/** The same mixed-status distribution remains grouped at three digits. */
export const GateDetailThreeDigitFanOut: Story = {
  args: { gate: makeFanOutGate(130) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(130);
    return <DetailFrame><TaskDetailView detail={fanOutDetail(gate)} gateInfo={{ record: gate, resolutionMode: "choice" }} /></DetailFrame>;
  },
};

/** Three-digit stress case also exposes the existing one-line row impact cell. */
export const ThreeDigitFanOut: Story = {
  args: { gate: makeFanOutGate(130) },
  render: (args) => {
    const gate = args.gate ?? makeFanOutGate(130);
    return (
      <div class="min-h-screen bg-canvas p-6">
        <div class="mx-auto flex max-w-[760px] flex-col gap-6">
          <div class="overflow-hidden rounded-[10px] border border-line bg-white [&_[data-testid=gate-row]>div:last-child]:w-max">
            <AccessibleGateRow gate={gate} />
          </div>
          <div class="h-[754px] w-[380px] overflow-hidden rounded-[10px] border border-line bg-white">
            <GateEgoPanel gate={gate} detailHref={`/gates/${gate.id}`} onOpen={() => undefined} />
          </div>
        </div>
      </div>
    );
  },
};
