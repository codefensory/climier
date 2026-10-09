import { createFileRoute, Link } from '@tanstack/react-router';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { ClimierLogo } from '@/components/logo';
import { CopyButton } from '@/components/landing/code';
import { DagDemo } from '@/components/landing/dag-demo';
import { ArrowRight, GithubIcon } from '@/components/landing/icons';
import { Invariants, Lifecycle, Quickstart } from '@/components/landing/sections';
import { GITHUB_URL, baseOptions } from '@/lib/layout.shared';

const INSTALL_COMMAND = 'bun add --global climier';

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
        <Invariants />
        <Lifecycle />
        <Quickstart />
      </div>
      <SiteFooter />
    </HomeLayout>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="landing-glow" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-[1200px] px-6 pt-16 pb-16 sm:pt-20">
        <div className="mx-auto flex max-w-[46rem] flex-col items-center text-center">
          <h1 className="landing-rise landing-rise-1 font-display text-[clamp(2.5rem,5vw,3.8rem)] leading-[1.03] font-bold tracking-[-0.035em] text-balance">
            Coordinate work with <span className="text-brand">confidence.</span>
          </h1>

          <p className="landing-rise landing-rise-2 mt-4 max-w-[64ch] text-[16.5px] leading-7 text-fd-muted-foreground">
            Climier is a durable task DAG for coordinating work, decisions, and knowledge across agents, sessions, and
            humans. Every change is validated, committed, and logged atomically.
          </p>

          <div className="landing-rise landing-rise-3 mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/docs/$"
              params={{ _splat: 'getting-started/quickstart' }}
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-foreground transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
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
              Source
            </a>
            <div className="inline-flex h-11 items-center gap-2 rounded-xl border border-fd-border bg-fd-card/70 ps-3.5 pe-1.5">
              <span className="font-mono text-[12.5px] text-fd-muted-foreground/70" aria-hidden="true">
                $
              </span>
              <code className="font-mono text-[12.5px] text-fd-foreground">{INSTALL_COMMAND}</code>
              <CopyButton value={INSTALL_COMMAND} label="Copy the install command" />
            </div>
          </div>
        </div>

        <div className="landing-rise landing-rise-4 mt-10 sm:mt-12">
          <DagDemo />
        </div>
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
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-fd-foreground"
          >
            <GithubIcon className="size-3.5" />
            codefensory/climier
          </a>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: { label: string; to: string }[] }) {
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
