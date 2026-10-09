import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { ClimierLogo } from '@/components/logo';

const GITHUB_URL = 'https://github.com/codefensory/climier';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <ClimierLogo className="h-[26px] w-auto" />,
      url: '/',
    },
    githubUrl: GITHUB_URL,
    links: [
      {
        text: 'Docs',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'Quickstart',
        url: '/docs/getting-started/quickstart',
      },
      {
        text: 'CLI reference',
        url: '/docs/reference/cli',
      },
    ],
  };
}

export { GITHUB_URL };
