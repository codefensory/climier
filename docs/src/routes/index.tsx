import { createFileRoute, Link } from '@tanstack/react-router';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import type { ReactNode } from 'react';
import { ClimierLogo } from '@/components/logo';
import { GITHUB_URL, baseOptions } from '@/lib/layout.shared';

export const Route = createFileRoute('/')({
  component: Home,
  head: () => ({
    meta: [
      { title: 'Climier — Coordinate work with confidence' },
      {
        name: 'description',
        content:
          'Climier is a durable task DAG for coordinating work, decisions, and knowledge across agents, sessions, and humans.',
      },
    ],
  }),
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="relative flex-1">
        <div className="landing-dots" aria-hidden="true" />
        <Hero />
        <Features />
        <Quickstart />
      </div>
      <SiteFooter />
    </HomeLayout>
  );
}

function Hero() {
  return (
    <section className="landing-glow relative mx-auto w-full max-w-[1200px] px-6 pt-20 pb-14 sm:pt-28 sm:pb-20">
      <div className="mx-auto max-w-3xl text-center">
        <span className="landing-eyebrow landing-rise landing-rise-1 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium text-fd-muted-foreground">
          <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
          v1.0 · JSON-first coordination
        </span>
        <h1 className="landing-rise landing-rise-2 mt-6 font-display text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.03] font-semibold tracking-[-0.035em] text-fd-foreground">
          Coordinate work with{' '}
          <span className="bg-gradient-to-r from-brand to-brand-contrast bg-clip-text text-transparent">
            confidence.
          </span>
        </h1>
        <p className="landing-rise landing-rise-3 mx-auto mt-6 max-w-2xl text-[17px] leading-7 text-fd-muted-foreground sm:text-lg">
          Climier is a durable task DAG for coordinating work, decisions, and knowledge across agents,
          sessions, and humans. Every change is validated, logged, and committed atomically.
        </p>
        <div className="landing-rise landing-rise-4 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/docs/$"
            params={{ _splat: 'getting-started/quickstart' }}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-fd-primary px-5 text-sm font-semibold text-fd-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Start the quickstart
            <ArrowRight />
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-fd-border bg-fd-card px-5 text-sm font-medium text-fd-foreground transition-colors hover:border-fd-ring hover:bg-fd-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <GithubIcon />
            View on GitHub
          </a>
        </div>
      </div>
      <div className="landing-rise landing-rise-4 mx-auto mt-16 max-w-3xl">
        <Terminal />
      </div>
    </section>
  );
}

function Terminal() {
  return (
    <div className="landing-terminal overflow-hidden rounded-2xl border border-fd-border text-left">
      <div className="flex items-center gap-2 border-b border-fd-border bg-fd-muted/50 px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" aria-hidden="true" />
        <span className="size-3 rounded-full bg-[#febc2e]" aria-hidden="true" />
        <span className="size-3 rounded-full bg-[#28c840]" aria-hidden="true" />
        <span className="ml-3 font-mono text-[12px] text-fd-muted-foreground">~/my-project</span>
      </div>
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-6">
        <code>
          <span className="text-fd-muted-foreground">$ </span>
          <span className="text-fd-foreground">climier status --initiative auth</span>
          {'\n'}
          <span className="text-fd-muted-foreground">{'{'}</span>
          {'\n'}
          <span className="text-fd-muted-foreground">{'  "summary": { '}</span>
          <span className="text-brand">{'"ready": 3'}</span>
          <span className="text-fd-muted-foreground">, </span>
          <span className="text-fd-foreground">{'"blocked": 1'}</span>
          <span className="text-fd-muted-foreground">{' }'}</span>
          {'\n'}
          <span className="text-fd-muted-foreground">{'}'}</span>
          {'\n\n'}
          <span className="text-fd-muted-foreground">$ </span>
          <span className="text-fd-foreground">climier take T-auth-1 --as alice</span>
          {'\n'}
          <span className="text-fd-muted-foreground">$ </span>
          <span className="text-fd-foreground">climier submit T-auth-1 --note "session store wired"</span>
          {'\n'}
          <span className="text-fd-muted-foreground">$ </span>
          <span className="text-fd-foreground">climier accept T-auth-1 --as reviewer</span>
        </code>
      </pre>
    </div>
  );
}

type Feature = {
  title: string;
  body: string;
  href: string;
  icon: ReactNode;
};

const FEATURES: Feature[] = [
  {
    title: 'One durable graph',
    body: 'Tasks, gates, and knowledge share a single validated JSON state with a revision fence and an append-only log.',
    href: '/docs/concepts/state-and-storage',
    icon: <GraphIcon />,
  },
  {
    title: 'Multi-agent safe',
    body: 'Every mutation enters one lock and commits state plus log atomically, so parallel agents never corrupt the file.',
    href: '/docs/guides/multi-agent',
    icon: <ShieldIcon />,
  },
  {
    title: 'JSON-only CLI',
    body: 'Each command prints one JSON value. Pipes, scripts, and agents get the same unambiguous contract.',
    href: '/docs/reference/cli',
    icon: <TerminalIcon />,
  },
  {
    title: 'Gates for decisions',
    body: 'Block work on an explicit decision, approval, or external dependency and record the resolution with its rationale.',
    href: '/docs/concepts/gates',
    icon: <GateIcon />,
  },
  {
    title: 'Shared knowledge',
    body: 'Scope findings to domains, initiatives, tags, or nodes so context reaches the work that needs it.',
    href: '/docs/concepts/knowledge',
    icon: <BookIcon />,
  },
  {
    title: 'Remote and extensible',
    body: 'Run an authenticated HTTP runtime or extend the catalog with plugins without leaving the mutation frontier.',
    href: '/docs/reference/self-hosting',
    icon: <ServerIcon />,
  },
];

function Features() {
  return (
    <section className="relative mx-auto w-full max-w-[1200px] px-6 py-16 sm:py-20">
      <div className="max-w-2xl">
        <p className="text-[13px] font-semibold tracking-[0.14em] text-brand uppercase">Built for coordination</p>
        <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.03em] text-fd-foreground sm:text-4xl">
          Everything the work needs, in one graph.
        </h2>
      </div>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <Link
            key={feature.href}
            to="/docs/$"
            params={{ _splat: feature.href.replace(/^\/docs\//, '') }}
            className="landing-card group flex flex-col rounded-2xl border border-fd-border bg-fd-card p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
              {feature.icon}
            </span>
            <h3 className="mt-4 font-display text-base font-semibold tracking-[-0.01em] text-fd-foreground">
              {feature.title}
            </h3>
            <p className="mt-2 flex-1 text-sm leading-6 text-fd-muted-foreground">{feature.body}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Read more
              <ArrowRight className="size-3.5" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const QUICKSTART_STEPS = [
  { label: 'Install the CLI', code: 'bun add --global climier' },
  { label: 'Create a project', code: 'climier init' },
  { label: 'Register a task', code: 'climier add-task T-1 --initiative core \\\n  --title "Wire the API" \\\n  --body "..." --acceptance "..."' },
  { label: 'See what is ready', code: 'climier status' },
];

function Quickstart() {
  return (
    <section className="relative mx-auto w-full max-w-[1200px] px-6 py-16 sm:py-20">
      <div className="grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-[13px] font-semibold tracking-[0.14em] text-brand uppercase">Quickstart</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.03em] text-fd-foreground sm:text-4xl">
            From zero to a ready task in four commands.
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-fd-muted-foreground">
            Install Climier, initialize a project, register the first task, and let the DAG tell you what is
            unblocked. The same commands work in a terminal, a script, or an agent.
          </p>
          <Link
            to="/docs/$"
            params={{ _splat: 'getting-started/install' }}
            className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
          >
            Read the installation guide
            <ArrowRight className="size-4" />
          </Link>
        </div>
        <ol className="flex flex-col gap-3">
          {QUICKSTART_STEPS.map((step, index) => (
            <li key={step.label} className="flex items-start gap-4 rounded-2xl border border-fd-border bg-fd-card p-4">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-fd-secondary font-mono text-[12px] font-medium text-fd-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fd-foreground">{step.label}</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-fd-muted px-3 py-2 font-mono text-[12.5px] leading-5 text-fd-muted-foreground">
                  <code>{step.code}</code>
                </pre>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="relative border-t border-fd-border bg-fd-background/60">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6 py-12 sm:flex-row sm:justify-between">
        <div>
          <ClimierLogo className="h-6 w-auto" />
          <p className="mt-3 max-w-xs text-sm leading-6 text-fd-muted-foreground">
            A JSON-first task DAG for coordinating work, decisions, and knowledge across agents and humans.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-14 gap-y-2 text-sm sm:grid-cols-3">
          <FooterColumn
            title="Get started"
            links={[
              { label: 'Install', to: 'getting-started/install' },
              { label: 'Quickstart', to: 'getting-started/quickstart' },
              { label: 'Core workflow', to: 'getting-started/core-workflow' },
            ]}
          />
          <FooterColumn
            title="Concepts"
            links={[
              { label: 'Tasks', to: 'concepts/tasks' },
              { label: 'Gates', to: 'concepts/gates' },
              { label: 'Knowledge', to: 'concepts/knowledge' },
            ]}
          />
          <FooterColumn
            title="Reference"
            links={[
              { label: 'CLI', to: 'reference/cli' },
              { label: 'Plugins', to: 'reference/plugins' },
              { label: 'Self-hosting', to: 'reference/self-hosting' },
            ]}
          />
        </div>
      </div>
      <div className="border-t border-fd-border">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-6 py-5 text-[13px] text-fd-muted-foreground">
          <span>© {new Date().getFullYear()} Climier. MIT licensed.</span>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-fd-foreground">
            <GithubIcon className="size-3.5" />
            codefensory/climier
          </a>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; to: string }[];
}) {
  return (
    <div>
      <p className="text-[13px] font-semibold text-fd-foreground">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.to}>
            <Link
              to="/docs/$"
              params={{ _splat: link.to }}
              className="text-fd-muted-foreground transition-colors hover:text-brand"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────────── */

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function ArrowRight({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function GithubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...iconProps} className={className} strokeWidth={1.5}>
      <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.6m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.3 5.4 2.6 5.4 2.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <circle cx="10" cy="18" r="2.4" />
      <path d="M8 7.2 15.8 8.4M7.7 8.3l1.6 7.5M16.8 10.1l-5 6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <path d="M12 3 5 6v5.5c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5V6l-7-3Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7 9 2.5 2.5L7 14m5.5.5H17" />
    </svg>
  );
}

function GateIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <path d="M5 21V4m0 0h11l-2 4 2 4H5" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg {...iconProps} className="size-[18px]">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
