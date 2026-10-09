import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import * as React from 'react';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import { NotFound } from '@/components/not-found';
import appCss from '@/styles/app.css?url';

const searchApi = `${import.meta.env.BASE_URL}api/search`;
const base = import.meta.env.BASE_URL;

const title = 'Climier';
const description =
  'Coordinate tasks, decisions, and shared knowledge in one durable DAG. Technical documentation for the Climier CLI, concepts, and self-hosting.';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title },
      { name: 'description', content: description },
      { name: 'theme-color', content: '#f6f6f6', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#0e0e11', media: '(prefers-color-scheme: dark)' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Climier' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:image', content: `${base}og.png` },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
      { name: 'twitter:image', content: `${base}og.png` },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: `${base}favicon.ico`, sizes: 'any' },
      { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` },
      { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ options: { type: 'static', api: searchApi } }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
