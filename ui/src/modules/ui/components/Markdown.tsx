import { createMemo, For, Show } from "solid-js";
import { parseMarkdown } from "../../core";
import type { MarkdownBlock, MarkdownInline } from "../../core";

export type MarkdownProps = {
  /** Texto en markdown. */
  source: string;
  /** `true` muestra el fuente crudo en un `<pre>` en vez del render. */
  raw?: boolean;
  /**
   * Tipografía y color. Se aplica al contenedor en los dos modos, así que el tamaño de letra lo
   * decide siempre el consumidor y no compite con una clase interna del componente.
   */
  class?: string;
};

const LINK_CLASS = "text-tone-blue-ink underline underline-offset-2 hover:text-ink";

function Inline(props: { nodes: MarkdownInline[] }): import("solid-js").JSX.Element {
  return (
    <For each={props.nodes}>{(node) => {
      switch (node.type) {
        case "text": return node.value;
        case "strong": return <strong class="font-semibold text-ink"><Inline nodes={node.children} /></strong>;
        case "em": return <em><Inline nodes={node.children} /></em>;
        case "del": return <del class="text-faint"><Inline nodes={node.children} /></del>;
        case "code": return <code class="rounded-[4px] bg-subtle px-1 py-[1px] font-mono text-[0.9em] text-ink">{node.value}</code>;
        case "link": return <a href={node.href} target="_blank" rel="noopener noreferrer" class={LINK_CLASS}><Inline nodes={node.children} /></a>;
      }
    }}</For>
  );
}

function Block(props: { block: MarkdownBlock }): import("solid-js").JSX.Element {
  const block = props.block;
  switch (block.type) {
    case "heading":
      return <p classList={{ "text-[15px] font-semibold text-ink": block.level <= 2, "text-[14px] font-semibold text-ink": block.level > 2 }}><Inline nodes={block.children} /></p>;
    case "paragraph":
      return <p><Inline nodes={block.children} /></p>;
    case "list":
      return (
        <Show when={block.ordered} fallback={<ul class="list-disc space-y-1 pl-5"><For each={block.items}>{(item) => <li><Inline nodes={item} /></li>}</For></ul>}>
          <ol class="list-decimal space-y-1 pl-5"><For each={block.items}>{(item) => <li><Inline nodes={item} /></li>}</For></ol>
        </Show>
      );
    case "code":
      return <pre class="overflow-x-auto rounded-[8px] bg-raised p-3 font-mono text-[12px] leading-[18px] text-ink-soft"><code>{block.value}</code></pre>;
    case "quote":
      return <blockquote class="border-l-2 border-line pl-3 text-muted"><Inline nodes={block.children} /></blockquote>;
    case "hr":
      return <hr class="border-hairline" />;
  }
}

/**
 * Render de markdown, o el fuente crudo.
 *
 * Es una primitiva visual genérica: no sabe de tareas ni de comentarios. Construye el DOM con
 * componentes de Solid (nunca `innerHTML`), así que el contenido no puede inyectar HTML y el
 * escape lo hace el propio renderer.
 */
export function Markdown(props: MarkdownProps) {
  const blocks = createMemo(() => parseMarkdown(props.source));
  return (
    <Show
      when={!props.raw}
      fallback={<pre data-testid="markdown-raw" class={"break-words font-mono whitespace-pre-wrap " + (props.class ?? "")}>{props.source}</pre>}
    >
      <div class={"space-y-4 " + (props.class ?? "")} data-testid="markdown">
        <For each={blocks()}>{(block) => <Block block={block} />}</For>
      </div>
    </Show>
  );
}
