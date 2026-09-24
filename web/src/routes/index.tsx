import { createFileRoute, notFound } from '@tanstack/react-router';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { useMDXComponents } from '@/components/mdx';

export const Route = createFileRoute('/')({
  component: Page,
});

function Page() {
  // `[]` resolves the content root index page (index.mdx -> slug `/`).
  const page = source.getPage([]);
  if (!page) throw notFound();

  const MDX = page.data.body;

  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      <DocsPage toc={page.data.toc}>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}
