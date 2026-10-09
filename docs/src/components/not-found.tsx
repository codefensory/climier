import { Link } from '@tanstack/react-router';
import { ClimierLogo } from '@/components/logo';

/** 404 surface, shared by the root `notFoundComponent` and the router default. */
export function NotFound() {
  return (
    <div className="climier-dots flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <ClimierLogo className="h-7 w-auto" />
      <div>
        <p className="font-mono text-sm font-medium text-brand">404</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-[-0.02em] text-fd-foreground">
          This page is not in the graph.
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-fd-muted-foreground">
          The page you were looking for does not exist or has moved. Head back to the documentation index.
        </p>
      </div>
      <Link
        to="/docs/$"
        params={{ _splat: '' }}
        className="inline-flex h-10 items-center rounded-xl bg-fd-primary px-4 text-sm font-semibold text-fd-primary-foreground transition-colors hover:opacity-90"
      >
        Back to the docs
      </Link>
    </div>
  );
}
