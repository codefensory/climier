import { createFileRoute, notFound } from '@tanstack/react-router';
import { Suspense, use } from 'react';
import { createServerFn } from '@tanstack/react-start';
import { useFumadocsLoader } from 'fumadocs-core/source/client';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { docs, source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { useMDXComponents } from '@/components/mdx';

export const Route = createFileRoute('/docs/$')({
  component: Page,
  head: ({ params }: { params: { _splat?: string } }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? [];
    const page = source.getPage(slugs);
    return {
      meta: [
        { title: page ? `${page.data.title} — Climier` : 'Climier documentation' },
        ...(page?.data.description ? [{ name: 'description', content: page.data.description }] : []),
      ],
    };
  },
  loader: async ({ params }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? [];
    const data = await loadPage({ data: slugs });
    await docs.getPage(data.path)?.preload();
    return data;
  },
});

const loadPage = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

function Content({ path }: { path: string }) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`Unknown documentation page: ${path}`);

  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

function Page() {
  const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout
      {...baseOptions()}
      tree={pageTree}
    >
      <Suspense>
        <Content path={path} />
      </Suspense>
    </DocsLayout>
  );
}
