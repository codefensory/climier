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

export { GITHUB_URL };
