import { Link } from '@tanstack/react-router';
import { GITHUB_URL } from '@/lib/layout.shared';

/**
 * Sidebar banner: a single, quiet call to action.
 *
 * The docs sidebar already carries search above it, so this stays short and
 * points at the one page a first-time reader needs.
 */
export function SidebarBanner() {
  return (
    <Link
      to="/docs/$"
      params={{ _splat: 'getting-started/quickstart' }}
      className="group mt-1 flex flex-col gap-1 rounded-xl border border-brand/25 bg-brand-soft p-3 transition-colors hover:border-brand/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-brand">
        <RocketIcon />
        New to Climier?
      </span>
      <span className="text-[12.5px] leading-5 text-fd-muted-foreground">
        Get a ready task in four commands with the quickstart guide.
      </span>
    </Link>
  );
}

/** Sidebar footer: the few links worth reaching from anywhere in the docs. */
export function SidebarFooter() {
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center gap-3">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-muted-foreground transition-colors hover:text-brand"
        >
          GitHub
        </a>
        <span className="text-fd-border" aria-hidden="true">
          ·
        </span>
        <Link
          to="/docs/$"
          params={{ _splat: 'reference/cli' }}
          className="text-fd-muted-foreground transition-colors hover:text-brand"
        >
          CLI reference
        </Link>
      </div>
      <p className="text-[12px] text-fd-muted-foreground/80">MIT licensed · v1.0</p>
    </div>
  );
}

function RocketIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden="true"
    >
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M9 13.5 5.5 15 5 19l4-.5 1.5-3.5" />
      <path d="M14 4c3.5 0 6 2.5 6 6 0 4-3.5 7-7 8l-3-3c1-3.5 4-7 8-7-1 0-2.5.5-4 2" />
    </svg>
  );
}
