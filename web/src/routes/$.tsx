import { createFileRoute, notFound } from '@tanstack/react-router';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { getAdjacentPages } from '@/lib/adjacent';
import { useMDXComponents } from '@/components/mdx';

export const Route = createFileRoute('/$')({
  beforeLoad: ({ params }) => {
    const slugs = params._splat?.split('/').filter((s) => s.length > 0) ?? [];
    // Unknown splat -> real 404 on the server response, before any render.
    if (!source.getPage(slugs)) throw notFound();
  },
  loader: async ({ params }) => ({
    adjacent: await getAdjacentPages({ data: `/${params._splat ?? ''}` }),
  }),
  component: Page,
});

function Page() {
  const { _splat } = Route.useParams();
  const { adjacent } = Route.useLoaderData();
  const slugs = _splat?.split('/').filter((s) => s.length > 0) ?? [];
  const page = source.getPage(slugs);
  if (!page) throw notFound();

  const MDX = page.data.body;

  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      <DocsPage
        toc={page.data.toc}
        footer={{
          items: {
            previous: adjacent.previous
              ? { name: adjacent.previous.title, url: adjacent.previous.url }
              : undefined,
            next: adjacent.next ? { name: adjacent.next.title, url: adjacent.next.url } : undefined,
          },
        }}
      >
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}
