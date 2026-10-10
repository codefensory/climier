import { useCallback, useEffect, useRef, useState } from 'react';
import { JsonLine } from './code';
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

/** Audit entry the kernel commits in the same write as the mutation. */
type LogEntry = { revision: number; action: string; agent: string; node: string };

type Phase = {
  key: string;
  /** tmux-style window name in the status bar. */
  label: string;
  /** Shell that runs the phase; the reviewer owns the last one. */
  actor: string;
  command: string;
  output: string[];
  note: string;
  /** The read that shows what the command did to the rest of the graph. */
  probe: string;
  probeOutput: string[];
  statuses: Record<string, Status>;
  counts: string;
  hold: number;
  revision: number;
  log: LogEntry;
};

/**
 * The hero's thesis: the graph derives its state, and only an accepted task
 * satisfies the edge that unblocks the next one. Every command and every key
 * below is what the CLI prints; `…` marks an elided field and `#` marks the
 * landing's own annotation, so the split between what a command returns and
 * what the graph derives stays visible.
 */
const PHASES: Phase[] = [
  {
    key: 'take',
    label: 'take',
    actor: 'alice',
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
    probe: 'climier context T-auth-1',
    probeOutput: [
      '{',
      '  "node": { "id": "T-auth-1", "status": "open", … },',
      '  "derived_status": "blocked",',
      '  "blocking": [',
      '    { "node": { "id": "T-auth-0", "status": "in_progress" },',
      '      "satisfied": false }',
      '  ]',
      '}',
    ],
    statuses: {
      'T-auth-0': 'in_progress',
      'T-auth-1': 'blocked',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    counts: '1 in progress · 2 blocked · 1 open gate',
    hold: 2200,
    revision: 5,
    log: { revision: 5, action: 'take', agent: 'alice', node: 'T-auth-0' },
  },
  {
    key: 'submit',
    label: 'submit',
    actor: 'alice',
    command: 'climier submit T-auth-0 --note "Reviewed in #34"',
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
    probe: 'climier context T-auth-1',
    probeOutput: [
      '{',
      '  "node": { "id": "T-auth-1", "status": "open", … },',
      '  "derived_status": "blocked",',
      '  "blocking": [',
      '    { "node": { "id": "T-auth-0", "status": "submitted" },',
      '      "satisfied": false }',
      '  ]',
      '}',
    ],
    statuses: {
      'T-auth-0': 'submitted',
      'T-auth-1': 'blocked',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    counts: '1 submitted · 2 blocked · 1 open gate',
    hold: 2200,
    revision: 6,
    log: { revision: 6, action: 'task.submit', agent: 'alice', node: 'T-auth-0' },
  },
  {
    key: 'accept',
    label: 'accept',
    actor: 'reviewer',
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
    note: 'Accepted. Acceptance satisfies the blocker, so the next read derives T-auth-1 as ready without editing it.',
    probe: 'climier context T-auth-1',
    probeOutput: [
      '{',
      '  "node": { "id": "T-auth-1", "status": "open", … },',
      '  "derived_status": "ready",',
      '  "blocking": [',
      '    { "node": { "id": "T-auth-0", "status": "done" },',
      '      "satisfied": true }',
      '  ]',
      '}',
    ],
    statuses: {
      'T-auth-0': 'done',
      'T-auth-1': 'ready',
      'G-auth-prod': 'open',
      'T-auth-2': 'blocked',
    },
    counts: '1 ready · 1 done · 1 blocked · 1 open gate',
    hold: 3000,
    revision: 7,
    log: { revision: 7, action: 'task.accept', agent: 'reviewer', node: 'T-auth-0' },
  },
];

/** Node centres, in percent of the graph box. Cards are 30% wide, so the gutters are the connectors. */
const NODES: DemoNode[] = [
  { id: 'T-auth-0', label: 'Session contract', kind: 'task', x: 16, y: 25, blocks: 'T-auth-1' },
  { id: 'T-auth-1', label: 'Session store', kind: 'task', x: 50, y: 25, blocks: 'T-auth-2' },
  { id: 'T-auth-2', label: 'Production cutover', kind: 'task', x: 84, y: 25 },
  { id: 'G-auth-prod', label: 'Cutover approval', kind: 'gate', x: 84, y: 75, blocks: 'T-auth-2' },
];

const EDGES: DemoEdge[] = [
  { from: 'T-auth-0', d: 'M 31 25 H 35', tip: { x: 34, y: 25 }, rotation: 0 },
  { from: 'T-auth-1', d: 'M 65 25 H 69', tip: { x: 68, y: 25 }, rotation: 0 },
  { from: 'G-auth-prod', d: 'M 84 59 V 42', tip: { x: 84, y: 43 }, rotation: -90 },
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

/**
 * Beats, not typing: a command lands whole, its result lands in one write, and
 * the viewport is what animates — it scrolls the result into view. The phase
 * `hold` is added by the data.
 */
const SHELL_BEAT_MS = 650;
const RESULT_BEAT_MS = 380;
const COMMENT_MS = 240;

function StatusGlyph({ status }: { status: Status }) {
  if (status === 'done' || status === 'resolved') return <CheckIcon className="size-3" />;
  if (status === 'submitted') return <UpGlyph className="size-3" />;
  if (status === 'blocked') return <BarredRingGlyph className="size-2.5" />;
  if (status === 'open') return <DiamondGlyph className="size-2.5" />;
  if (status === 'in_progress') return <DotGlyph className="size-2 landing-pulse" />;
  return <DotGlyph className="size-2" />;
}

/**
 * The pill is keyed by its status at the call site, so the flip ring plays on
 * the beat the derived value actually changes rather than on every re-render.
 */
function StatusPill({ status, animate }: { status: Status; animate?: boolean }) {
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
            strokeDasharray={SATISFIED.has(statuses[edge.from]) ? undefined : '3 3'}
            className={SATISFIED.has(statuses[edge.from]) ? EDGE_STROKE.satisfied : EDGE_STROKE.idle}
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
            SATISFIED.has(statuses[edge.from]) ? 'text-brand' : 'text-fd-muted-foreground/55'
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
                <span className="hidden text-fd-muted-foreground/80 sm:inline"> · {node.kind}</span>
                {node.blocks ? <span className="sm:hidden"> · BLOCKS → {node.blocks}</span> : null}
              </span>
              <div className="flex min-w-0 items-center justify-start gap-2 sm:flex-col sm:items-start sm:gap-1.5">
                <p className="min-w-0 truncate text-[13px] font-medium text-fd-foreground sm:w-full sm:flex-none">
                  {node.label}
                </p>
                <StatusPill key={status} status={status} animate={animate} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Item =
  | { kind: 'command'; actor: string; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'comment'; text: string };

function itemsFor(phase: Phase): Item[] {
  return [
    { kind: 'command', actor: phase.actor, text: phase.command },
    ...phase.output.map((text) => ({ kind: 'json' as const, text })),
    { kind: 'command', actor: phase.actor, text: phase.probe },
    ...phase.probeOutput.map((text) => ({ kind: 'json' as const, text })),
    {
      kind: 'comment',
      text: `log rev ${phase.log.revision} · ${phase.log.action} · ${phase.log.agent} · ${phase.log.node}`,
    },
  ];
}

/**
 * The items a command just produced: its result lands in one write, never line
 * by line, so the viewport scrolls it into view instead of typing it out.
 */
function resultEnd(items: Item[], from: number): number {
  let end = from;
  while (end < items.length && items[end].kind === 'json') end += 1;
  return end;
}

function Prompt({ actor }: { actor: string }) {
  return (
    <>
      <span className="text-fd-success">{actor}@climier</span>
      <span className="text-fd-muted-foreground">:~/projects/auth</span>
      <span className="text-fd-muted-foreground"> $ </span>
    </>
  );
}

/** A static block cursor when paused; the controls mirror the same state. */
function Caret({ blinking }: { blinking: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[1.05em] w-[0.55em] translate-y-[0.18em] bg-fd-foreground/75 ${
        blinking ? 'landing-caret' : ''
      }`}
    />
  );
}

function Line({ item }: { item: Item }) {
  if (item.kind === 'command') {
    return (
      <div className="landing-output whitespace-pre-wrap break-words">
        <Prompt actor={item.actor} />
        <span className="text-fd-foreground">{item.text}</span>
      </div>
    );
  }
  if (item.kind === 'comment') {
    return (
      <div className="landing-output whitespace-pre-wrap break-words text-fd-muted-foreground">
        # {item.text}
      </div>
    );
  }
  return (
    <div className="landing-output whitespace-pre-wrap break-words">
      <JsonLine line={item.text} />
    </div>
  );
}

export function DagDemo() {
  const [phase, setPhase] = useState(0);
  /** The session is already one command deep, so the first paint is a run, not an empty box. */
  const [cursor, setCursor] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  const panel = useRef<HTMLElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  /** Auto-scroll only while the reader is already at the bottom. */
  const stick = useRef(true);

  const current = PHASES[phase];
  const items = itemsFor(current);
  const idle = cursor >= items.length;

  const goTo = useCallback((index: number, instant: boolean) => {
    setPhase(index);
    setCursor(instant ? itemsFor(PHASES[index]).length : 0);
    stick.current = true;
  }, []);

  useEffect(() => {
    const node = panel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? true));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  /** Reduced motion skips the beats: the phase is simply on screen. */
  useEffect(() => {
    if (!reduceMotion) return;
    setCursor(itemsFor(PHASES[phase]).length);
  }, [reduceMotion, phase]);

  useEffect(() => {
    if (!playing || !visible || reduceMotion) return;

    const list = itemsFor(current);
    const item = list[cursor];

    if (!item) {
      const id = setTimeout(() => goTo((phase + 1) % PHASES.length, false), current.hold);
      return () => clearTimeout(id);
    }

    if (item.kind === 'command') {
      const id = setTimeout(() => setCursor((value) => value + 1), SHELL_BEAT_MS);
      return () => clearTimeout(id);
    }

    if (item.kind === 'json') {
      const id = setTimeout(() => setCursor(resultEnd(list, cursor)), RESULT_BEAT_MS);
      return () => clearTimeout(id);
    }

    const id = setTimeout(() => setCursor((value) => value + 1), COMMENT_MS);
    return () => clearTimeout(id);
  }, [current, cursor, goTo, phase, playing, reduceMotion, visible]);

  /** Reduced motion still walks the phases, so the demo stays a fixed loop. */
  useEffect(() => {
    if (!reduceMotion || !playing || !visible) return;
    const id = setTimeout(() => goTo((phase + 1) % PHASES.length, false), current.hold);
    return () => clearTimeout(id);
  }, [current.hold, goTo, phase, playing, reduceMotion, visible]);

  /**
   * The result arrives whole, so the reader sees it move: the viewport glides to
   * the bottom instead of jumping. A phase change rewinds instantly.
   */
  const lastPhase = useRef(phase);
  useEffect(() => {
    const node = viewport.current;
    const rewound = lastPhase.current !== phase;
    lastPhase.current = phase;
    if (!node || !stick.current) return;
    node.scrollTo({ top: node.scrollHeight, behavior: reduceMotion || rewound ? 'auto' : 'smooth' });
  }, [phase, cursor, reduceMotion]);

  const onScroll = () => {
    const node = viewport.current;
    if (!node) return;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  return (
    <figure
      ref={panel}
      className={`landing-panel relative overflow-hidden rounded-2xl border border-fd-border ${
        visible ? '' : 'landing-offscreen'
      }`}
    >
      <figcaption className="sr-only">
        A four-node Climier graph in the initiative “auth”. The gate G-auth-prod and the task T-auth-0 both block
        T-auth-2, and T-auth-0 blocks T-auth-1. A terminal session takes T-auth-0, submits it, and accepts it: after
        submission T-auth-1 is still blocked, and only acceptance satisfies the blocker and derives T-auth-1 as ready.
      </figcaption>

      <div className="flex items-center gap-2 border-b border-fd-border bg-fd-muted/40 px-3 py-2 sm:px-4">
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-fd-error" />
          <span className="size-2.5 rounded-full bg-fd-warning" />
          <span className="size-2.5 rounded-full bg-fd-success" />
        </span>
        <span className="ms-1.5 min-w-0 truncate font-mono text-[12px] text-fd-muted-foreground sm:text-[12.5px]">
          <span className="text-fd-foreground">climier</span> — auth
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-0.5">
          <span className="me-1.5 font-mono text-[12px] tabular-nums text-fd-muted-foreground sm:me-2">
            rev {current.revision}
          </span>
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            aria-pressed={playing}
            aria-label={playing ? 'Pause the terminal session' : 'Play the terminal session'}
            className="inline-flex size-7 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            onClick={() => {
              goTo(0, false);
              setPlaying(true);
            }}
            aria-label="Restart the terminal session"
            className="inline-flex size-7 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <ReplayIcon />
          </button>
        </span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,0.52fr)_minmax(0,0.48fr)]">
        <div className="flex flex-col justify-start gap-3 border-b border-fd-border/70 bg-fd-muted/30 p-3 sm:p-4 lg:border-e lg:border-b-0 lg:p-5">
          <div className="mx-auto w-full max-w-[34rem]">
            <Graph phase={current} animate={visible} />
          </div>
          <p className="min-h-[3rem] max-w-[62ch] text-[14px] leading-6 text-fd-muted-foreground">{current.note}</p>
        </div>

        <div
          ref={viewport}
          onScroll={onScroll}
          className="h-[15rem] overflow-y-auto px-3 py-3 font-mono text-[12px] leading-[1.4rem] sm:h-[18rem] sm:px-4 sm:py-4 sm:text-[12.5px] lg:h-[24rem] lg:leading-[1.45rem]"
        >
          <div className="min-w-full">
            {PHASES.slice(0, phase + 1).map((item, index) => {
              const rows = index < phase ? itemsFor(item) : items.slice(0, cursor);
              return rows.map((row, rowIndex) => <Line key={`${item.key}:${rowIndex}`} item={row} />);
            })}

            {/* The shell's cursor closes the session: a bare block while it runs,
              * the prompt again once the phase is done. */}
            <div className="whitespace-pre-wrap break-words">
              {idle ? <Prompt actor={current.actor} /> : null}
              <Caret blinking={playing && visible} />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-fd-border bg-fd-muted/40 px-3 py-1.5 sm:px-4">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${playing ? 'bg-brand landing-pulse' : 'bg-fd-border'}`}
        />
        <ol className="flex min-w-0 items-center gap-1">
          {PHASES.map((item, index) => {
            const state = index === phase ? 'current' : index < phase ? 'done' : 'next';
            return (
              <li key={item.key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    goTo(index, true);
                    setPlaying(false);
                  }}
                  aria-current={state === 'current' ? 'step' : undefined}
                  aria-label={`Step ${index + 1}: ${item.command}`}
                  className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                    state === 'current'
                      ? 'bg-brand text-brand-foreground'
                      : state === 'done'
                        ? 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground'
                        : 'text-fd-muted-foreground/60 hover:bg-fd-accent hover:text-fd-foreground'
                  }`}
                >
                  {index + 1}:{item.label}
                </button>
              </li>
            );
          })}
        </ol>
        <span className="ms-auto hidden min-w-0 truncate font-mono text-[12px] text-fd-muted-foreground sm:block">
          {current.counts}
        </span>
      </div>
    </figure>
  );
}
