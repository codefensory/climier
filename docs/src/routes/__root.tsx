import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import * as React from 'react';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import appCss from '@/styles/app.css?url';

const searchApi = `${import.meta.env.BASE_URL}api/search`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Climier documentation' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html suppressHydrationWarning>
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
