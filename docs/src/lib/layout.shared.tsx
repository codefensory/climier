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
  };
}

/**
 * The landing is a single page, so it drops the docs search UI and points at
 * the documentation instead. The docs layout keeps the shared options above.
 */
export function homeOptions(): BaseLayoutProps {
  return {
    ...baseOptions(),
    searchToggle: { enabled: false },
    links: [{ text: 'Documentation', url: '/docs' }],
  };
}

export { GITHUB_URL };
