import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  } satisfies MDXComponents;
}

/** The component map fumadocs injects into every compiled MDX module. */
export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = MDXComponents;
}
