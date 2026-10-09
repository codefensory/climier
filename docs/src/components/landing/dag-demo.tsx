import { useEffect, useRef, useState } from 'react';
import { JsonLine, Panel } from './code';
import {
  BarredRingGlyph,
  CheckIcon,
  ChevronIcon,
  DiamondGlyph,
  DotGlyph,
  PauseIcon,
  PlayIcon,
  ReplayIcon,
  UpGlyph,
} from './icons';

type Status =
  | 'ready'
  | 'blocked'
  | 'in_progress'
  | 'submitted'
  | 'done'
  | 'open'
  | 'resolved'
  | 'archived';

/** The statuses that satisfy a BLOCKS edge, per the read model. */
const SATISFIED = new Set<Status>(['done', 'archived', 'resolved']);

type DemoNode = {
  id: string;
  label: string;
  kind: 'task' | 'gate';
  x: number;
  y: number;
  blocks?: string;
};

type DemoEdge = {
  /** Node whose `done` state satisfies the edge. */
  from: string;
  d: string;
  /** Arrowhead anchor, in graph percentage coordinates. */
  tip: { x: number; y: number };
  rotation: number;
};

type LogEntry = {
  revision: number;
  action: string;
  agent: string;
  node: string;
};

type Phase = {
  key: string;
  label: string;
  command: string;
  output: string[];
  note: string;
  hold: number;
  revision: number;
  statuses: Record<string, Status>;
  pools: { label: string; count: number; status: Status }[];
  log: LogEntry;
};

/** Node centres, in percent of the graph box. Cards are 30% wide, so the gutters are the connectors. */
const NODES: DemoNode[] = [
  {
    id: 'T-auth-0',
    label: 'Session contract',
    kind: 'task',
    x: 16,
    y: 25,
    blocks: 'T-auth-1',
  },
  {
    id: 'T-auth-1',
    label: 'Session store',
    kind: 'task',
    x: 50,
    y: 25,
    blocks: 'T-auth-2',
  },
  { id: 'T-auth-2', label: 'Production cutover', kind: 'task', x: 84, y: 25 },
  {
    id: 'G-auth-prod',
    label: 'Cutover approval',
    kind: 'gate',
    x: 84,
    y: 75,
    blocks: 'T-auth-2',
  },
];

const EDGES: DemoEdge[] = [
  { from: 'T-auth-0', d: 'M 31 25 H 35', tip: { x: 34, y: 25 }, rotation: 0 },
  { from: 'T-auth-1', d: 'M 65 25 H 69', tip: { x: 68, y: 25 }, rotation: 0 },
  {
    from: 'G-auth-prod',
    d: 'M 84 59 V 42',
    tip: { x: 84, y: 43 },
    rotation: -90,
  },
];

const PHASES: Phase[] = [
  {
    key: 'take',
    label: 'take',
    command: 'climier take T-auth-0 --as alice',
    output: [
      '{',
      '  "node": {',
      '    "id": "T-auth-0",',
      '    "status": "in_progress"',
      '  },',
      '  "freshly_claimed": true',
      '}',
    ],
    note: 'alice holds the claim on the blocker. Nothing downstream moves yet.',
    hold: 10000,
    revision: 5,
    statuses: {
      'T-auth-0': 'in_progress',
      'T-auth-1': 'blocked',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    pools: [
      { label: 'in progress', count: 1, status: 'in_progress' },
      { label: 'blocked', count: 2, status: 'blocked' },
      { label: 'open gates', count: 1, status: 'open' },
    ],
    log: { revision: 5, action: 'take', agent: 'alice', node: 'T-auth-0' },
  },
  {
    key: 'submit',
    label: 'submit',
    command: 'climier submit T-auth-0 --note "Contract reviewed in #34"',
    output: [
      '{',
      '  "node": {',
      '    "id": "T-auth-0",',
      '    "status": "submitted"',
      '  },',
      '  "newly_ready": []',
      '}',
    ],
    note: 'Submitted is not done. Only done, archived, or a resolved gate satisfies a BLOCKS edge.',
    hold: 10000,
    revision: 6,
    statuses: {
      'T-auth-0': 'submitted',
      'T-auth-1': 'blocked',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    pools: [
      { label: 'submitted', count: 1, status: 'submitted' },
      { label: 'blocked', count: 2, status: 'blocked' },
      { label: 'open gates', count: 1, status: 'open' },
    ],
    log: {
      revision: 6,
      action: 'task.submit',
      agent: 'alice',
      node: 'T-auth-0',
    },
  },
  {
    key: 'accept',
    label: 'accept',
    command: 'climier accept T-auth-0 --as reviewer',
    output: [
      '{',
      '  "node": {',
      '    "id": "T-auth-0",',
      '    "status": "done"',
      '  },',
      '  "newly_ready": [',
      '    "T-auth-1"',
      '  ]',
      '}',
    ],
    note: 'Accepted. The next read derives T-auth-1 as ready without editing it.',
    hold: 12000,
    revision: 7,
    statuses: {
      'T-auth-0': 'done',
      'T-auth-1': 'ready',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    pools: [
      { label: 'done', count: 1, status: 'done' },
      { label: 'ready', count: 1, status: 'ready' },
      { label: 'blocked', count: 1, status: 'blocked' },
      { label: 'open gates', count: 1, status: 'open' },
    ],
    log: {
      revision: 7,
      action: 'task.accept',
      agent: 'reviewer',
      node: 'T-auth-0',
    },
  },
];

const STATUS_LABEL: Record<Status, string> = {
  ready: 'ready',
  blocked: 'blocked',
  in_progress: 'in progress',
  submitted: 'submitted',
  done: 'done',
  open: 'open',
  resolved: 'resolved',
  archived: 'archived',
};

const STATUS_SKIN: Record<Status, string> = {
  ready: 'border-transparent bg-brand text-brand-foreground',
  in_progress: 'border-brand/25 bg-brand-soft text-brand',
  submitted: 'border-fd-border/70 bg-fd-muted text-fd-foreground',
  done: 'border-transparent bg-fd-success/15 text-fd-success',
  resolved: 'border-transparent bg-fd-success/15 text-fd-success',
  archived: 'border-fd-border/70 bg-fd-muted text-fd-muted-foreground',
  blocked: 'border-fd-border/70 bg-fd-muted/60 text-fd-muted-foreground',
  open: 'border-fd-border/70 bg-transparent text-fd-muted-foreground',
};

const EDGE_STROKE = {
  idle: 'stroke-fd-muted-foreground/45',
  satisfied: 'stroke-brand',
};

function StatusGlyph({ status }: { status: Status }) {
  if (status === 'done' || status === 'resolved')
    return <CheckIcon className="size-3" />;
  if (status === 'submitted') return <UpGlyph className="size-3" />;
  if (status === 'blocked') return <BarredRingGlyph className="size-2.5" />;
  if (status === 'open') return <DiamondGlyph className="size-2.5" />;
  if (status === 'in_progress')
    return <DotGlyph className="size-2 landing-pulse" />;
  return <DotGlyph className="size-2" />;
}

function StatusPill({
  status,
  animate,
}: {
  status: Status;
  animate?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[12px] leading-5 ${
        STATUS_SKIN[status]
      } ${animate ? 'landing-flip' : ''}`}
    >
      <StatusGlyph status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The wide graph uses directed BLOCKS edges; the mobile list labels each relation in words. */
function Graph({ phase, animate }: { phase: Phase; animate: boolean }) {
  const statuses = phase.statuses;
  return (
    <div className="flex flex-col gap-2 sm:relative sm:block sm:aspect-[2/1] sm:gap-0">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 z-0 hidden size-full sm:block"
        aria-hidden="true"
      >
        {EDGES.map((edge) => (
          <path
            key={edge.from}
            d={edge.d}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeWidth={2.2}
            strokeDasharray={
              SATISFIED.has(statuses[edge.from]) ? undefined : '3 3'
            }
            className={
              SATISFIED.has(statuses[edge.from])
                ? EDGE_STROKE.satisfied
                : EDGE_STROKE.idle
            }
          />
        ))}
      </svg>

      {EDGES.map((edge) => (
        <span
          key={edge.from}
          aria-hidden="true"
          style={{
            left: `${edge.tip.x}%`,
            top: `${edge.tip.y}%`,
            translate: '-50% -50%',
            rotate: `${edge.rotation}deg`,
          }}
          className={`absolute z-20 hidden sm:block ${
            SATISFIED.has(statuses[edge.from])
              ? 'text-brand'
              : 'text-fd-muted-foreground/55'
          }`}
        >
          <ChevronIcon />
        </span>
      ))}

      {NODES.map((node) => {
        const status = statuses[node.id];
        const cardSkin =
          node.kind === 'gate'
            ? 'border-dashed border-fd-border bg-fd-muted/60'
            : status === 'ready'
              ? 'border-brand/50 bg-fd-card ring-3 ring-brand/10'
              : 'border-fd-border/80 bg-fd-card';
        return (
          <div key={node.id} className="relative sm:static">
            <div
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
              className={`z-10 flex flex-col gap-1 rounded-xl border px-3 py-2 shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:absolute sm:w-[30%] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:gap-1.5 sm:p-3 ${cardSkin}`}
            >
              <span className="min-w-0 truncate font-mono text-[12px] text-fd-muted-foreground">
                {node.id}
                <span className="hidden text-fd-muted-foreground/80 sm:inline">
                  {' '}
                  · {node.kind}
                </span>
                {node.blocks ? (
                  <span className="sm:hidden"> · BLOCKS → {node.blocks}</span>
                ) : null}
              </span>
              <div className="flex min-w-0 items-center justify-start gap-2 sm:flex-col sm:items-start sm:gap-1.5">
                <p className="min-w-0 truncate text-[13px] font-medium text-fd-foreground sm:w-full sm:flex-none">
                  {node.label}
                </p>
                <StatusPill status={status} animate={animate} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Console({ phase, playing }: { phase: Phase; playing: boolean }) {
  const log = PHASES.slice(0, PHASES.indexOf(phase) + 1).map(
    (item) => item.log,
  );

  return (
    <div className="flex min-w-0 flex-col border-t border-fd-border/70 lg:border-s lg:border-t-0">
      <div className="flex-1 p-3 sm:p-5">
        <div className="flex min-h-8 items-start gap-2 font-mono text-[12.5px] leading-5 sm:text-[13px]">
          <span
            className="select-none text-fd-muted-foreground"
            aria-hidden="true"
          >
            $
          </span>
          <span className="min-w-0 break-words text-fd-foreground">
            {phase.command}
          </span>
          <span
            aria-hidden="true"
            className={`mt-1.5 h-3.5 w-[7px] shrink-0 bg-brand ${playing ? 'landing-caret' : ''}`}
          />
        </div>
        <pre className="mt-2 overflow-x-auto font-mono text-[12.5px] leading-5 sm:text-[13px]">
          <code>
            {phase.output.map((line, index) => (
              <div
                key={line}
                className="landing-output"
                style={{ animationDelay: `${60 + index * 45}ms` }}
              >
                <JsonLine line={line} />
              </div>
            ))}
          </code>
        </pre>
      </div>

      <div className="border-t border-fd-border/70 p-3 sm:px-5 sm:py-4">
        <span className="font-mono text-[12.5px] tracking-[0.02em] text-fd-muted-foreground">
          log · append-only
        </span>
        <ul className="mt-1 grid gap-1 font-mono text-[12.5px] leading-4 sm:mt-2 sm:gap-2 sm:leading-5">
          {log.map((entry, index) => {
            const latest = index === log.length - 1;
            return (
              <li
                key={`${entry.revision}-${entry.action}`}
                className={`grid grid-cols-[0.375rem_minmax(0,1fr)] items-start gap-2 ${
                  latest ? 'text-fd-foreground' : 'text-fd-muted-foreground'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-[0.45rem] size-1.5 rounded-full ${latest ? 'bg-brand' : 'bg-fd-border'}`}
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span>
                    <span className="text-fd-muted-foreground">rev </span>
                    <span className="tabular-nums">{entry.revision}</span>
                  </span>
                  <span>
                    <span className="text-fd-muted-foreground">action </span>
                    {entry.action}
                  </span>
                  <span>
                    <span className="text-fd-muted-foreground">actor </span>
                    {entry.agent}
                  </span>
                  <span>
                    <span className="text-fd-muted-foreground">node </span>
                    {entry.node}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * The hero's thesis: the graph derives its state, and only an accepted task
 * satisfies the edge that unblocks the next one. The scripted session mirrors
 * real CLI output, so the split between what a command returns and what the
 * graph derives stays visible.
 */
export function DagDemo() {
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(true);
  const panel = useRef<HTMLElement | null>(null);
  const current = PHASES[phase];

  useEffect(() => {
    const node = panel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries[0]?.isIntersecting ?? true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    const id = setTimeout(
      () => setPhase((value) => (value + 1) % PHASES.length),
      current.hold,
    );
    return () => clearTimeout(id);
  }, [playing, visible, current.hold, phase]);

  return (
    <Panel
      as="figure"
      ref={panel}
      className={`landing-panel${visible ? '' : ' landing-offscreen'}`}
    >
      <figcaption className="sr-only">
        A four-node Climier graph in the initiative “auth”. The task T-auth-0 is
        taken, submitted, and accepted. Acceptance is what satisfies its blocker
        edge and derives T-auth-1 as ready; submission does not.
      </figcaption>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-4 py-2 lg:flex lg:flex-wrap lg:gap-x-4 lg:px-5">
        <span className="col-span-full row-start-1 flex min-w-0 items-center gap-1.5 lg:col-auto lg:row-auto lg:flex-none">
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${playing ? 'bg-brand landing-pulse' : 'bg-fd-border'}`}
          />
          <span className="font-mono text-[13px] font-medium text-fd-foreground">
            climier
          </span>
          <span className="whitespace-nowrap font-mono text-[12px] tracking-[0.02em] text-fd-muted-foreground sm:text-[12.5px]">
            status --initiative auth
          </span>
        </span>
        <ul className="col-start-1 row-start-2 flex flex-wrap items-center gap-2 lg:col-auto lg:row-auto">
          {current.pools.map((pool) => (
            <li
              key={pool.label}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[12px] leading-5 ${STATUS_SKIN[pool.status]}`}
            >
              <StatusGlyph status={pool.status} />
              <span className="tabular-nums">{pool.count}</span>
              {pool.label}
            </li>
          ))}
        </ul>
        <div className="col-start-2 row-start-2 flex shrink-0 items-center justify-end gap-0.5 lg:col-auto lg:row-auto lg:ms-auto lg:gap-1">
          <span className="me-1.5 font-mono text-[12.5px] tabular-nums text-fd-muted-foreground lg:me-2">
            rev {current.revision}
          </span>
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            aria-pressed={playing}
            aria-label={
              playing ? 'Pause the graph sequence' : 'Play the graph sequence'
            }
            className="inline-flex size-7 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:size-8"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase(0);
              setPlaying(true);
            }}
            aria-label="Restart the graph sequence"
            className="inline-flex size-7 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:size-8"
          >
            <ReplayIcon />
          </button>
        </div>
      </div>

      <div className="grid border-t border-fd-border/70 lg:grid-cols-[minmax(0,1.04fr)_minmax(0,0.96fr)]">
        <div className="flex flex-col justify-center gap-3 border-b border-fd-border/70 bg-fd-muted/30 p-3 sm:gap-4 sm:p-4 lg:border-b-0 lg:p-5">
          <Graph phase={current} animate={visible} />
          <p className="max-w-[62ch] text-[15px] leading-6 text-fd-muted-foreground">
            {current.note}
          </p>
        </div>
        <Console phase={current} playing={playing} />
      </div>

      <ol className="grid grid-cols-3 gap-2 border-t border-fd-border/70 p-3 sm:gap-3 sm:px-5">
        {PHASES.map((item, index) => {
          const active = index === phase;
          const done = index < phase;
          return (
            <li key={item.key} className="min-w-0">
              <button
                type="button"
                onClick={() => {
                  setPhase(index);
                  setPlaying(false);
                }}
                aria-current={active ? 'step' : undefined}
                aria-label={`Step ${index + 1}: ${item.command}`}
                className={`flex min-h-[3.75rem] w-full flex-col items-start justify-center gap-1 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-[4.5rem] sm:px-3 ${
                  active
                    ? 'border-brand/50 bg-brand-soft/50 hover:bg-brand-soft/70'
                    : done
                      ? 'border-fd-border bg-fd-muted/40 hover:bg-fd-muted/70'
                      : 'border-fd-border/70 bg-transparent hover:bg-fd-muted/40'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] leading-none ${
                      active
                        ? 'border-brand bg-brand text-brand-foreground'
                        : done
                          ? 'border-fd-border text-fd-muted-foreground'
                          : 'border-fd-border/70 text-fd-muted-foreground'
                    }`}
                  >
                    {done ? <CheckIcon className="size-3.5" /> : index + 1}
                  </span>
                  <span className="font-mono text-[12.5px] text-fd-foreground">
                    {item.label}
                  </span>
                </span>
                <span className="text-[12px] leading-4 text-fd-muted-foreground">
                  {active ? 'current step' : done ? 'completed' : 'up next'}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
