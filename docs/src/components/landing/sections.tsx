import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CopyButton, JsonLine, Panel, PanelLabel } from './code';
import { ArrowRight } from './icons';

function DocsLink({ to, children, className = '' }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link
      to="/docs/$"
      params={{ _splat: to }}
      className={`inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${className}`}
    >
      {children}
      <ArrowRight className="size-3.5" />
    </Link>
  );
}

/* ── Invariants ─────────────────────────────────────────────────────────── */

const SATISFACTION = [
  { blocker: 'task', rule: 'done or archived' },
  { blocker: 'gate', rule: 'resolved, or superseded by a resolved gate' },
  { blocker: 'knowledge', rule: 'never' },
  { blocker: 'missing node or cycle', rule: 'never' },
];

function DerivationSpecimen() {
  return (
    <Panel>
      <div className="flex items-center justify-between border-b border-fd-border px-4 py-2.5">
        <PanelLabel>incoming BLOCKS edge</PanelLabel>
        <PanelLabel>satisfied when</PanelLabel>
      </div>
      <table className="w-full text-[13.5px]">
        <thead className="sr-only">
          <tr>
            <th scope="col">blocker kind</th>
            <th scope="col">satisfied when</th>
          </tr>
        </thead>
        <tbody>
          {SATISFACTION.map((row) => (
            <tr key={row.blocker} className="border-b border-fd-border last:border-b-0">
              <td className="px-4 py-2.5 align-top font-mono text-[12px] text-fd-muted-foreground">{row.blocker}</td>
              <td className="px-4 py-2.5 align-top text-fd-foreground">{row.rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-fd-border bg-fd-muted/40 px-4 py-3 text-[12.5px] leading-5 text-fd-muted-foreground">
        <span className="font-mono text-fd-foreground">submitted</span> waits for validation. It never satisfies a
        blocker, no matter how long the review takes.
      </p>
    </Panel>
  );
}

const COMMIT_FILES = [
  { path: '.lock', value: 'held for one write' },
  { path: 'tasks.json', value: 'rev 7' },
  { path: 'revision-ledger.json', value: 'rev 7' },
  { path: 'log', value: 'entry 7 appended' },
];

function CommitSpecimen() {
  return (
    <Panel>
      <div className="border-b border-fd-border px-4 py-2.5">
        <PanelLabel>~/.climier/projects/&lt;id&gt;/</PanelLabel>
      </div>
      <dl className="grid gap-px bg-fd-border">
        {COMMIT_FILES.map((file) => (
          <div key={file.path} className="flex items-baseline justify-between gap-4 bg-fd-card px-4 py-2.5">
            <dt className="font-mono text-[12.5px] text-fd-foreground">{file.path}</dt>
            <dd className="font-mono text-[12px] text-fd-muted-foreground">{file.value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-fd-border bg-fd-muted/40 px-4 py-3 text-[12.5px] leading-5 text-fd-muted-foreground">
        One lock per project, so writers serialize instead of racing. Add{' '}
        <span className="font-mono text-fd-foreground">--if-revision N</span> and the write fails when the node moved
        since you read it.
      </p>
    </Panel>
  );
}

const ALERT_LINES = [
  '{',
  '  "alerts": [',
  '    { "kind": "stale-claim",',
  '      "severity": "warning",',
  '      "task_id": "T-auth-3",',
  '      "claimed_by": "bob", … }',
  '  ]',
  '}',
];

function ClaimSpecimen() {
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fd-border px-4 py-2.5">
        <PanelLabel className="truncate">climier status --stale-ms 1800000</PanelLabel>
        <span className="flex shrink-0 items-center gap-3">
          <PanelLabel>exit 0</PanelLabel>
          <span className="inline-flex items-center rounded-full border border-fd-warning/40 bg-fd-warning/15 px-2 py-0.5 font-mono text-[10.5px] text-fd-warning">
            severity: warning
          </span>
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-5">
        <code>
          {ALERT_LINES.map((line) => (
            <div key={line}>
              <JsonLine line={line} />
            </div>
          ))}
        </code>
      </pre>
      <p className="border-t border-fd-border bg-fd-muted/40 px-4 py-3 text-[12.5px] leading-5 text-fd-muted-foreground">
        Narrow the read with <span className="font-mono text-fd-foreground">--claimed-by alice</span>. Counts stay global:
        a claim is visible to everyone, not only to the agent that took it.
      </p>
    </Panel>
  );
}

const INVARIANTS: { title: string; body: ReactNode; specimen: ReactNode }[] = [
  {
    title: 'Ready and blocked are derived, never stored.',
    body: (
      <>
        The snapshot keeps one lifecycle value per node. <span className="font-mono text-[13px]">ready</span> and{' '}
        <span className="font-mono text-[13px]">blocked</span> are recomputed from the graph on every read, so a reported
        status cannot drift away from the work behind it.
      </>
    ),
    specimen: <DerivationSpecimen />,
  },
  {
    title: 'Every mutation is one locked, atomic commit.',
    body: (
      <>
        State, revision ledger, and audit log land together under a single project lock. Two writers serialize instead of
        interleaving, and the log can never describe a state that was not written.
      </>
    ),
    specimen: <CommitSpecimen />,
  },
  {
    title: 'Every claim names its actor, and stale ones surface.',
    body: (
      <>
        Mutating commands record who acted. A claim is visible to the whole project, and a claim held too long raises an
        alert instead of silently squatting on ready work.
      </>
    ),
    specimen: <ClaimSpecimen />,
  },
];

export function Invariants() {
  return (
    <section className="relative mx-auto w-full max-w-[1200px] px-6 py-16 sm:py-20">
      <div className="max-w-[62ch]">
        <h2 className="font-display text-[clamp(1.75rem,3.2vw,2.5rem)] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
          How the graph stays honest.
        </h2>
        <p className="mt-4 text-[16px] leading-7 text-fd-muted-foreground">
          Climier keeps one snapshot, one write path, and one derivation. Nothing else is allowed to become a second
          source of truth.
        </p>
      </div>
      <div className="mt-10">
        {INVARIANTS.map((item) => (
          <article
            key={item.title}
            className="grid gap-6 border-t border-fd-border py-10 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-14"
          >
            <div className="min-w-0">
              <h3 className="font-display text-[19px] leading-7 font-semibold tracking-[-0.015em] text-balance">
                {item.title}
              </h3>
              <p className="mt-3 max-w-[46ch] text-[15px] leading-7 text-fd-muted-foreground">{item.body}</p>
            </div>
            <div className="min-w-0">{item.specimen}</div>
          </article>
        ))}
      </div>
      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-fd-border pt-8">
        <DocsLink to="concepts/edges-and-status">Read the derivation rules</DocsLink>
        <DocsLink to="concepts/state-and-storage">See the state shape</DocsLink>
      </div>
    </section>
  );
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

const LIFECYCLE = [
  { status: 'open', command: 'climier add-task T-1 …', detail: 'Registered. Ready when no blocker is unsatisfied.' },
  { status: 'in_progress', command: 'climier take T-1 --as alice', detail: 'One claimant. The claim is stamped and visible.' },
  { status: 'submitted', command: 'climier submit T-1 --note "…"', detail: 'Under review. Downstream stays blocked.' },
  { status: 'done', command: 'climier accept T-1 --as reviewer', detail: 'Accepted. Downstream BLOCKS edges are satisfied.' },
];

const OFF_RAMPS = [
  { name: 'reject', move: 'submitted → open', command: 'climier reject T-1 --reason "…"' },
  { name: 'release', move: 'in_progress → open', command: 'climier release T-1' },
  { name: 'cancel', move: 'any → canceled', command: 'climier cancel T-1 --reason "…"' },
];

export function Lifecycle() {
  return (
    <section className="relative mx-auto w-full max-w-[1200px] px-6 pb-16 sm:pb-20">
      <div className="max-w-[58ch]">
        <h2 className="font-display text-[clamp(1.75rem,3.2vw,2.5rem)] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
          The lifecycle, once.
        </h2>
        <p className="mt-4 text-[16px] leading-7 text-fd-muted-foreground">
          Four persisted states, each written by one command. Everything the graph reports is derived from where a node
          sits on this line.
        </p>
      </div>

      <ol className="relative mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        <span aria-hidden="true" className="absolute inset-x-0 top-3 hidden h-px bg-fd-border lg:block" />
        {LIFECYCLE.map((step) => (
          <li key={step.status} className="relative flex flex-col gap-3">
            <span className="inline-flex w-fit bg-fd-background pe-4">
              <span className="inline-flex items-center rounded-full border border-fd-border bg-fd-card px-2.5 py-1 font-mono text-[11px] text-fd-foreground">
                {step.status}
              </span>
            </span>
            <div>
              <p className="font-mono text-[12px] break-words text-fd-foreground">{step.command}</p>
              <p className="mt-2 max-w-[30ch] text-[13.5px] leading-6 text-fd-muted-foreground">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <dl className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-fd-border bg-fd-border sm:grid-cols-3">
        {OFF_RAMPS.map((ramp) => (
          <div key={ramp.name} className="bg-fd-card p-4">
            <dt className="flex items-baseline gap-2">
              <span className="font-mono text-[13px] font-medium text-fd-foreground">{ramp.name}</span>
              <span className="font-mono text-[11px] text-fd-muted-foreground">{ramp.move}</span>
            </dt>
            <dd className="mt-2 font-mono text-[11.5px] leading-5 text-fd-muted-foreground">{ramp.command}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ── Quickstart ─────────────────────────────────────────────────────────── */

const SCRIPT = [
  { text: '# requires Bun 1.4+', comment: true },
  { text: 'bun add --global climier' },
  { text: 'mkdir climier-demo && cd climier-demo' },
  { text: 'climier init' },
  { text: 'climier add-initiative demo --as alice' },
  { text: 'climier add-task T-example-1 --initiative demo \\' },
  { text: '  --title "Write the first task" \\' },
  { text: '  --body "Complete the first piece of work in the demo project." \\' },
  { text: '  --acceptance "The work is complete and its checks pass." \\' },
  { text: '  --blocked-by "" --as alice' },
  { text: 'climier status' },
];

const SCRIPT_TEXT = SCRIPT.map((line) => line.text).join('\n');

export function Quickstart() {
  return (
    <section className="landing-band relative">
      <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 px-6 py-16 sm:py-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14">
        <div className="min-w-0">
          <h2 className="font-display text-[clamp(1.8rem,3.2vw,2.5rem)] leading-[1.08] font-bold tracking-[-0.03em] text-balance">
            From an empty directory to a ready task.
          </h2>
          <p className="landing-band-lede mt-4 max-w-[46ch] text-[16px] leading-7">
            Eleven lines, no server, no account. The same commands work in a terminal, a script, or an agent — they all
            read the same JSON.
          </p>
          <Link
            to="/docs/$"
            params={{ _splat: 'getting-started/quickstart' }}
            className="mt-7 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-foreground transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Start the quickstart
            <ArrowRight />
          </Link>
        </div>

        <Panel className="min-w-0">
          <div className="flex items-center gap-2 border-b border-fd-border bg-fd-muted/50 px-4 py-2.5">
            <PanelLabel>terminal</PanelLabel>
            <CopyButton value={SCRIPT_TEXT} label="Copy the quickstart commands" className="ms-auto" />
          </div>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6 sm:text-[12.5px]">
            <code>
              {SCRIPT.map((line) => (
                <div key={line.text} className={line.comment ? 'text-fd-muted-foreground' : 'text-fd-foreground'}>
                  {line.comment ? (
                    line.text
                  ) : (
                    <>
                      <span className="select-none text-fd-muted-foreground/70">
                        {line.text.startsWith('  ') ? '  ' : '$ '}
                      </span>
                      {line.text.trimStart()}
                    </>
                  )}
                </div>
              ))}
            </code>
          </pre>
        </Panel>
      </div>
    </section>
  );
}
