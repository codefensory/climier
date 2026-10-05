import { children, type JSX } from "solid-js";

export type PageFrameProps = {
  header?: JSX.Element;
  children?: JSX.Element;
};

/** Frame compartido: controles en una fila completa y contenido en una única columna. */
export function PageFrame(props: PageFrameProps) {
  const header = children(() => props.header);
  const content = children(() => props.children);
  const headerContent = header();
  const contentNodes = content();
  const hasHeader = headerContent != null;

  return (
    <div class="min-h-full min-w-0">
      {hasHeader && <header data-testid="page-header" class="page-frame-inset flex min-h-11 items-center gap-3 border-b border-separator py-1">
        {headerContent}
      </header>}
      <div class="page-frame-inset pb-7" classList={{ "pt-4": hasHeader, "pt-6": !hasHeader }}>{contentNodes}</div>
    </div>
  );
}
