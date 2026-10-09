import { createFileRoute, Link } from '@tanstack/react-router';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-16">
        <p className="mb-4 text-sm font-medium text-fd-muted-foreground">Documentation</p>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-fd-foreground sm:text-5xl">
          Coordinate work with confidence.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
          Climier is a durable task DAG for coordinating work, decisions, and knowledge across agents and humans.
        </p>
        <div className="mt-8">
          <Link
            to="/docs/$"
            params={{ _splat: '' }}
            className="inline-flex rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground"
          >
            Read the documentation
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
