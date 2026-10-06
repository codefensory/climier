/**
 * Parser de markdown → AST puro.
 *
 * Cubre el subconjunto que producen los agentes en bodies y notas: párrafos, títulos, listas,
 * bloques de código, citas, reglas, y en línea negrita/cursiva/tachado/código/links.
 *
 * No usa `innerHTML` ni sanidad externa: el render (en `ui`) recorre este árbol y emite nodos de
 * texto. Un `<script>` o un `[x](javascript:…)` no se interpretan — el link inseguro queda como
 * texto plano.
 *
 * Deliberadamente no soporta tablas, listas anidadas, HTML crudo ni imágenes: son casos que el
 * contenido de climier no usa, y cada uno agrega superficie de parser sin consumidor real.
 */

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "del"; children: MarkdownInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { type: "heading"; level: number; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] }
  | { type: "code"; lang: string; value: string }
  | { type: "quote"; children: MarkdownInline[] }
  | { type: "hr" };

/** Sólo estos esquemas se convierten en `<a>`; el resto se muestra como texto. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

const FENCE = /^\s*```(\S*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

const isWord = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9]/.test(char);

/** Un `_`/`__` pegado a una palabra (`snake_case`) no es un delimitador. */
function underscoreDelimiter(source: string, open: number, delim: string, close: number): boolean {
  if (delim[0] !== "_") return true;
  return !isWord(source[open - 1]) && !isWord(source[close + delim.length]);
}

/**
 * Inline de una línea: negrita, cursiva, tachado, código y links.
 *
 * El escaneo es de izquierda a derecha y resuelve el primer delimitador con cierre. Alcanza para
 * texto de agentes; no busca el par más largo ni soporta anidado ambiguo (`*a **b** c*`).
 */
export function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let text = "";
  let index = 0;

  const flush = () => {
    if (text) {
      nodes.push({ type: "text", value: text });
      text = "";
    }
  };

  while (index < source.length) {
    const char = source[index];

    if (char === "\\" && index + 1 < source.length) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ type: "code", value: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (char === "[") {
      const labelEnd = source.indexOf("]", index + 1);
      const hrefEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && source[labelEnd + 1] === "(" && hrefEnd > labelEnd + 2) {
        const href = source.slice(labelEnd + 2, hrefEnd).trim();
        if (SAFE_LINK.test(href)) {
          flush();
          nodes.push({ type: "link", href, children: parseInline(source.slice(index + 1, labelEnd)) });
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    const strong = char === "*" || char === "_" ? char.repeat(2) : "";
    if (strong && source.startsWith(strong, index)) {
      const end = source.indexOf(strong, index + 2);
      if (end > index + 2 && underscoreDelimiter(source, index, strong, end)) {
        flush();
        nodes.push({ type: "strong", children: parseInline(source.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (char === "~" && source.startsWith("~~", index)) {
      const end = source.indexOf("~~", index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ type: "del", children: parseInline(source.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const end = source.indexOf(char, index + 1);
      if (end > index + 1 && underscoreDelimiter(source, index, char, end)) {
        flush();
        nodes.push({ type: "em", children: parseInline(source.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }

    text += char;
    index += 1;
  }

  flush();
  return nodes;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || RULE.test(line);
}

/** Markdown → bloques. Entrada inválida o vacía devuelve `[]`, nunca tira. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_END.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", lang: fence[1] ?? "", value: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quote.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      blocks.push({ type: "quote", children: parseInline(quote.join(" ").trim()) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /^\d/.test(item[2]);
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index]);
        if (!match || /^\d/.test(match[2]) !== ordered) break;
        let value = match[3];
        index += 1;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && /^\s{2,}/.test(lines[index])) {
          value += ` ${lines[index].trim()}`;
          index += 1;
        }
        items.push(parseInline(value.trim()));
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}
